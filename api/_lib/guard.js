/**
 * api/_lib/guard.js —— 服务端接口统一防护
 *
 * 这些接口背后是我们自己付费的配额（Gemini / DigiKey / Mouser / ezPLM）。
 * 知道 URL 的第三方可以直接刷，所以每个入口都要过一遍限流与体积检查。
 *
 * 说明与边界：
 * - Serverless 每个实例内存独立，本限流是**单实例**的。实例横向扩展时
 *   总配额会被放大 N 倍。这能挡住脚本化滥刷，但不是分布式配额控制；
 *   真正的全局限额需要 Redis/KV，见 README「已知限制」。
 * - 无登录体系时按 IP + 可选 session 头限流，为将来的 userId/tenantId 预留了字段。
 */

const buckets = new Map();      // key -> { hits: number[], concurrent: number }
const LAST_SWEEP = { at: Date.now() };

function envInt(name, dflt) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export const LIMITS = {
  get windowMs() { return envInt('API_RATE_WINDOW_MS', 60_000); },
  get perWindow() { return envInt('API_RATE_PER_MIN', 30); },
  get concurrent() { return envInt('API_MAX_CONCURRENT', 4); },
  get bodyBytes() { return envInt('API_MAX_BODY_BYTES', 8 * 1024 * 1024); },
  get promptChars() { return envInt('AI_MAX_PROMPT_CHARS', 24_000); },
  get fileBytes() { return envInt('AI_MAX_FILE_BYTES', 4 * 1024 * 1024); },
  get timeoutMs() { return envInt('API_TIMEOUT_MS', 30_000); },
};

/** 调用方身份：优先可选的 session/user 头，回落到 IP */
export function callerKey(req) {
  const sess = String(req.headers['x-cc-session'] ?? '').slice(0, 64);
  if (sess) return `s:${sess}`;
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = fwd || req.socket?.remoteAddress || 'unknown';
  return `ip:${ip}`;
}

function sweep(now) {
  if (now - LAST_SWEEP.at < 60_000) return;
  LAST_SWEEP.at = now;
  for (const [k, b] of buckets) {
    if (!b.concurrent && (!b.hits.length || now - b.hits[b.hits.length - 1] > 300_000)) buckets.delete(k);
  }
}

/**
 * 频率 + 并发检查。通过返回 release 函数（务必在 finally 调用）。
 * @returns {{ ok: true, release: () => void } | { ok: false, status: number, error: string, retryAfter?: number }}
 */
export function acquire(req, scope = 'default') {
  const now = Date.now();
  sweep(now);
  const key = `${scope}|${callerKey(req)}`;
  const b = buckets.get(key) ?? { hits: [], concurrent: 0 };
  buckets.set(key, b);

  const win = LIMITS.windowMs;
  b.hits = b.hits.filter((t) => now - t < win);

  if (b.hits.length >= LIMITS.perWindow) {
    const retryAfter = Math.ceil((win - (now - b.hits[0])) / 1000);
    return { ok: false, status: 429, error: '请求过于频繁，请稍后再试', retryAfter };
  }
  if (b.concurrent >= LIMITS.concurrent) {
    return { ok: false, status: 429, error: '并发请求过多，请稍后再试', retryAfter: 2 };
  }

  b.hits.push(now);
  b.concurrent++;
  let released = false;
  return {
    ok: true,
    release: () => { if (!released) { released = true; b.concurrent = Math.max(0, b.concurrent - 1); } },
  };
}

/** 请求体体积检查（Content-Length + 实际字符串长度双保险） */
export function checkBodySize(req, maxBytes = LIMITS.bodyBytes) {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (declared && declared > maxBytes) {
    return { ok: false, status: 413, error: `请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限` };
  }
  const body = req.body;
  if (typeof body === 'string' && Buffer.byteLength(body) > maxBytes) {
    return { ok: false, status: 413, error: '请求体超过上限' };
  }
  return { ok: true };
}

/** AI 入参检查：prompt 长度、附件大小、MIME 白名单 */
export function checkAiPayload(body) {
  const prompt = String(body?.prompt ?? '');
  if (prompt.length > LIMITS.promptChars) {
    return { ok: false, status: 413, error: `prompt 超过 ${LIMITS.promptChars} 字符上限` };
  }
  const b64Len = (v) => (typeof v === 'string' ? Math.floor(v.length * 0.75) : 0);
  const imgBytes = b64Len(body?.imageBase64);
  const pdfBytes = b64Len(body?.pdfBase64);
  if (Math.max(imgBytes, pdfBytes) > LIMITS.fileBytes) {
    return { ok: false, status: 413, error: `附件超过 ${Math.round(LIMITS.fileBytes / 1024 / 1024)}MB 上限` };
  }
  if (body?.imageBase64) {
    const mime = String(body?.imageMime ?? 'image/png');
    if (!/^image\/(png|jpeg|webp)$/.test(mime)) {
      return { ok: false, status: 415, error: '图片仅支持 PNG / JPEG / WebP' };
    }
  }
  return { ok: true };
}

/** 统一出错响应 */
export function deny(res, r) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (r.retryAfter) res.setHeader('Retry-After', String(r.retryAfter));
  return res.status(r.status).send(JSON.stringify({ error: r.error }));
}

/** 供测试用：重置内部计数 */
export function __resetGuard() { buckets.clear(); }

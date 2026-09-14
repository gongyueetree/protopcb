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

/**
 * 调用方身份 —— 配额主体。
 *
 * 安全设计（本轮修复的核心）：
 * 1. 客户端可以随意伪造的 header（x-cc-session）**绝不能替代 IP 作为配额主体**。
 *    旧实现 `if (sess) return 's:'+sess` 意味着攻击者每次换一个 session 值就能
 *    拿到全新配额 —— 等于没有限流。现在 session 只作为附注（日志/调试），
 *    配额键永远以可信 IP 为主体。
 * 2. x-forwarded-for 不可盲信（客户端可自带伪造值）。Vercel/常见反代会把真实
 *    客户端 IP **追加到链尾**（最后一跳由平台写入），因此取右端第一个公网地址；
 *    平台专用头（x-vercel-forwarded-for / x-real-ip）优先。
 * 3. 未来接入 ezPLM Auth 后：verifyAuth(req) 返回 { userId, tenantId } 时，
 *    配额主体切换为 `u:{tenantId}:{userId}`（服务端验证过的身份才可作为主体）。
 *
 * 注意：本模块是**单实例内存限流**，不是全局配额（见 GlobalRateLimiter 注释与 README）。
 */
const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd])/i;

function clientIp(req) {
  // 平台注入的头最可信（Vercel 会覆盖而非透传客户端伪造值）
  const platform = String(req.headers['x-vercel-forwarded-for'] ?? req.headers['x-real-ip'] ?? '').split(',')[0].trim();
  if (platform) return platform;
  // x-forwarded-for：反代把真实 IP 追加在链尾 → 从右往左取第一个非私网地址
  const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!PRIVATE_IP.test(chain[i])) return chain[i];
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * @param {*} req
 * @param {{ userId?: string, tenantId?: string } | null} [auth] 服务端验证过的身份（预留 ezPLM Auth 接口）
 */
export function callerKey(req, auth = null) {
  if (auth?.userId) return `u:${auth.tenantId ?? '-'}:${auth.userId}`;
  return `ip:${clientIp(req)}`;
}

/**
 * GlobalRateLimiter 抽象 —— 单实例内存实现，仅为 fallback。
 * Serverless 横向扩展时每个实例配额独立（总配额被放大 N 倍）；
 * 真正的全局限额需替换为 Upstash Redis / Vercel KV 实现（接口保持不变）。
 */
export const globalRateLimiter = {
  kind: 'memory-fallback',
  /** 预留：未来 Redis 实现 async acquire(key, limits) → { ok, retryAfter } */
};

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
export function acquire(req, scope = 'default', overrides = undefined) {
  const now = Date.now();
  sweep(now);
  const key = `${scope}|${callerKey(req)}`;
  const b = buckets.get(key) ?? { hits: [], concurrent: 0 };
  buckets.set(key, b);

  const win = overrides?.windowMs ?? LIMITS.windowMs;
  const perWindow = overrides?.perWindow ?? LIMITS.perWindow;
  b.hits = b.hits.filter((t) => now - t < win);

  if (b.hits.length >= perWindow) {
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
  const pdfBytes = Math.max(b64Len(body?.pdfBase64), b64Len(body?.fileBase64));
  if (Math.max(imgBytes, pdfBytes) > LIMITS.fileBytes) {
    return { ok: false, status: 413, error: `附件超过 ${Math.round(LIMITS.fileBytes / 1024 / 1024)}MB 上限` };
  }
  if (body?.imageBase64) {
    const mime = String(body?.imageMime ?? 'image/png');
    if (!/^image\/(png|jpeg|webp)$/.test(mime)) {
      return { ok: false, status: 415, error: '图片仅支持 PNG / JPEG / WebP' };
    }
  }
  // PDF 魔数：base64 的 "%PDF" 固定是 "JVBERi0"，不是 PDF 的字节别当 PDF 送模型
  if (body?.pdfBase64 && !String(body.pdfBase64).startsWith('JVBERi0')) {
    return { ok: false, status: 415, error: '附件不是有效的 PDF 文件' };
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

/**
 * 稳健读取请求体。
 *
 * Vercel/Node 在不同情形下会把 body 交成对象、字符串或 Buffer
 * （大 base64 负载尤其容易拿到 Buffer）。此前只处理前两种，
 * 拿到 Buffer 时字段全部读不到 → 立刻回 400「prompt required」，
 * 表现为「一上传就失败」。
 */
export function readJsonBody(req) {
  const b = req?.body;
  if (b == null) return {};
  if (typeof b === 'object' && !Buffer.isBuffer(b) && !(b instanceof Uint8Array)) return b;
  try {
    const text = Buffer.isBuffer(b) || b instanceof Uint8Array
      ? Buffer.from(b).toString('utf8')
      : String(b);
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

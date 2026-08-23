/**
 * api/_lib/net.js —— 所有出站（outbound）上游请求的统一通道
 *
 * 背景：safeFetch 只保护"用户提供的 URL"（SSRF 面）。而 Gemini / DigiKey /
 * Mouser / ezPLM / GitLab 这类"我们自己发起、消耗我们自己 Key 或服务器资源"
 * 的请求此前直接裸 fetch：无超时（可挂住 serverless 实例）、无响应体上限
 * （上游异常返回大体积时内存被吃光）、错误体原样回传用户（可能泄露上游细节）。
 *
 * 本模块提供：
 *   fetchWithTimeout(url, opts)      — AbortController 超时 + 统一错误类型
 *   readResponseLimited(res, opts)   — 流式累计读取，超上限立即 cancel
 *   fetchUpstream(url, opts)         — 上面两者的组合便捷入口（json/text/buffer）
 *
 * 约定：上游错误不把完整 body 透传给终端用户，只保留截断摘要用于日志/detail。
 */

export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: 'timeout'|'too_large'|'http'|'network', status?: number, detail?: string }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = info.kind;
    this.status = info.status;
    this.detail = (info.detail ?? '').slice(0, 200);
  }
}

function envInt(name, dflt) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export const NET_DEFAULTS = {
  get timeoutMs() { return envInt('API_TIMEOUT_MS', 30_000); },
  get maxResponseBytes() { return envInt('API_MAX_UPSTREAM_BYTES', 16 * 1024 * 1024); },
};

/**
 * 带超时的 fetch。调用方负责读取/取消 body。
 * @returns {Promise<{ res: Response, done: () => void }>} done() 必须在读取结束后调用以清理计时器
 */
export async function fetchWithTimeout(url, { timeoutMs = NET_DEFAULTS.timeoutMs, signal, ...init } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('upstream timeout')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctl.abort(signal.reason), { once: true });
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    return { res, done: () => clearTimeout(timer) };
  } catch (e) {
    clearTimeout(timer);
    if (ctl.signal.aborted) throw new UpstreamError('上游请求超时', { kind: 'timeout', detail: String(e?.message ?? e) });
    throw new UpstreamError('上游网络请求失败', { kind: 'network', detail: String(e?.message ?? e) });
  }
}

/**
 * 流式读取响应体并限制大小；超限立即 cancel 释放连接。
 * @returns {Promise<Buffer>}
 */
export async function readResponseLimited(res, { maxBytes = NET_DEFAULTS.maxResponseBytes } = {}) {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared && declared > maxBytes) {
    throw new UpstreamError(`上游响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, { kind: 'too_large' });
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new UpstreamError('上游响应超过大小上限', { kind: 'too_large' });
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError(`上游响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, { kind: 'too_large' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * 便捷入口：超时 + 大小限制 + 按需解析。
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number, maxResponseBytes?: number, as?: 'json'|'text'|'buffer'|'response', okOnly?: boolean }} opts
 *   as='response' 时返回 { res }（调用方自行流式处理，务必消费或 cancel body）
 * @returns {Promise<{ res: Response, json?: any, text?: string, buffer?: Buffer }>}
 */
export async function fetchUpstream(url, { timeoutMs, maxResponseBytes, as = 'buffer', okOnly = false, ...init } = {}) {
  const { res, done } = await fetchWithTimeout(url, { timeoutMs, ...init });
  try {
    if (as === 'response') { done(); return { res }; }
    if (okOnly && !res.ok) {
      // 读取截断摘要用于诊断，但不把完整 body 透传
      const buf = await readResponseLimited(res, { maxBytes: 64 * 1024 }).catch(() => Buffer.alloc(0));
      throw new UpstreamError(`上游返回 HTTP ${res.status}`, { kind: 'http', status: res.status, detail: buf.toString('utf8').slice(0, 200) });
    }
    const buffer = await readResponseLimited(res, { maxBytes: maxResponseBytes ?? NET_DEFAULTS.maxResponseBytes });
    if (as === 'buffer') return { res, buffer };
    const text = buffer.toString('utf8');
    if (as === 'text') return { res, text };
    try {
      return { res, json: JSON.parse(text), text };
    } catch {
      throw new UpstreamError('上游返回的不是有效 JSON', { kind: 'http', status: res.status, detail: text.slice(0, 200) });
    }
  } finally {
    done();
  }
}

/** 把 UpstreamError 折叠成对终端用户安全的响应体（不透传上游完整 body） */
export function upstreamErrorBody(e, fallback = '上游服务暂不可用') {
  if (e instanceof UpstreamError) {
    const status = e.kind === 'timeout' ? 504 : e.kind === 'too_large' ? 502 : e.kind === 'http' && e.status === 429 ? 429 : 502;
    return { status, body: { error: e.message || fallback } };
  }
  return { status: 502, body: { error: fallback } };
}

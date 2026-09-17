import { requireAuthenticatedCapability } from './_lib/session.js';
import { signJwt } from './_lib/ezplm-jwt.js';
import { acquire, checkBodySize, deny, readJsonBody } from './_lib/guard.js';
/**
 * api/ds2kicad.js — DS2KiCad 提取引擎代理（BFF）
 *
 * DS2KiCad 的 /api/extract 要求 ezPLM 会话 JWT（HS256, EZPLM_JWT_SECRET 验签）。
 * 本代理为服务端到服务端调用：用同一密钥现签短期 JWT，经 Authorization: Bearer 携带
 * —— 浏览器全程不接触密钥（这正是 ds2kicad 的 BFF 设计意图）。
 *
 * Vercel 环境变量：
 *   DS2KICAD_URL      = ds2kicad 实例地址（如 https://ds2kicad.vercel.app）
 *   EZPLM_JWT_SECRET  = 与 ds2kicad 实例配置的同一 HS256 密钥
 *     （ds2kicad 侧未配置该密钥且 AUTH_MODE=dev 时可不带 JWT）
 *
 * GET  /api/ds2kicad            → { configured, hasJwt }
 * POST /api/ds2kicad  body {pdfUrl} 或 {pdfBase64, fileName} → 透传 extract 响应
 */
import { fetchWithTimeout, readResponseLimited } from './_lib/net.js';
/** 统一出站通道（本文件所有上游请求走这里）：超时 + 响应体上限 */
async function tfetch(url, init = {}) {
  const { res, done } = await fetchWithTimeout(url, { timeoutMs: init.timeoutMs ?? 20_000, ...init });
  try {
    const buf = await readResponseLimited(res, { maxBytes: init.maxResponseBytes ?? 4 * 1024 * 1024 });
    return {
      ok: res.ok, status: res.status, headers: res.headers,
      json: async () => JSON.parse(buf.toString('utf8')),
      text: async () => buf.toString('utf8'),
    };
  } finally { done(); }
}



export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 提取能力统一由 /api/ai 的 part.extract 承担（服务端计费与权限）。
  // 本端点消耗 DS2KiCad 配额，外部匿名调用一律拒绝，在任何上游调用之前。
  if (req.method === 'POST') {
    const gate = await requireAuthenticatedCapability(req, 'part.custom');
    if (!gate.ok) return res.status(gate.status).send(JSON.stringify(gate.body));
  }
  // 配额防护：这些接口消耗自有 API 额度，需限制频率/并发/体积
  const sizeCheck = checkBodySize(req);
  if (!sizeCheck.ok) return deny(res, sizeCheck);
  const lease = acquire(req, 'ds2kicad');
  if (!lease.ok) return deny(res, lease);
  try {
  const base = (process.env.DS2KICAD_URL ?? '').trim().replace(/\/+$/, '') || undefined;
  const secret = (process.env.EZPLM_JWT_SECRET ?? '').trim() || undefined;

  if (req.method === 'GET') {
    return res.status(200).send(JSON.stringify({ configured: !!base, hasJwt: !!secret }));
  }
  if (!base) {
    return res.status(501).send(JSON.stringify({ error: 'DS2KICAD_URL 未配置' }));
  }
  try {
    const body = JSON.stringify(readJsonBody(req));
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers.Authorization = `Bearer ${signJwt(secret)}`;
    const r = await tfetch(`${base}/api/extract`, { method: 'POST', headers, body });
    const text = await r.text();
    // 鉴权失败时给出可操作的提示（而不是裸 400/401）
    if (r.status === 401 || r.status === 403) {
      return res.status(r.status).send(JSON.stringify({
        error: 'ds2kicad 鉴权失败：请在 Vercel 配置 EZPLM_JWT_SECRET（与 ds2kicad 实例的同名变量一致），或将 ds2kicad 的 AUTH_MODE 设为 dev',
        upstream: text.slice(0, 200),
      }));
    }
    return res.status(r.status).send(text);
  } catch (err) {
    return res.status(502).send(JSON.stringify({ error: 'ds2kicad 调用失败', detail: String(err).slice(0, 200) }));
  }
  } finally {
    lease.release();
  }
}

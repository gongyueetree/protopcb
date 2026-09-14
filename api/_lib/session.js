/**
 * api/_lib/session.js
 * AI 端点的**服务端关卡** —— 未登录一律拒绝，登录后按 Credit 扣费。
 *
 * 为什么必须在服务端：前端把按钮藏起来挡不住任何人直接 POST /api/gemini。
 * "未注册用户不能用 AI"如果只做在 UI 上，等于没做。
 *
 * 身份来源：浏览器带上 ezPLM / EEHub 签发的会话（Cookie 或 Authorization: Bearer）。
 * 我们不自己签发会话，只做**校验 + 扣费**，账本在 ezPLM 侧。
 *
 * 后端尚未提供校验/扣费端点时，行为由 AI_REQUIRE_AUTH 决定：
 *   未设置或 '1'（默认，也是线上该用的）→ 一律拒绝，返回 BACKEND_NOT_CONNECTED，
 *     宁可 AI 全部不可用，也不能在没有鉴权的情况下敞开付费接口；
 *   '0'（仅本地开发）→ 放行并在响应里标注 authBypassed，便于本地调试。
 */
import { fetchUpstream, UpstreamError } from './net.js';

const AUTH_BASE = (process.env.EZPLM_AUTH_BASE ?? '').trim();     // 如 https://ezplm.cn/api/v1
const REQUIRE_AUTH = (process.env.AI_REQUIRE_AUTH ?? '1').trim() !== '0';

/** 从请求里取会话令牌：优先 Authorization: Bearer，其次 Cookie */
export function sessionTokenOf(req) {
  const auth = String(req.headers['authorization'] ?? '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const cookie = String(req.headers['cookie'] ?? '');
  const c = cookie.match(/(?:^|;\s*)(?:ezplm_session|eehub_session)=([^;]+)/);
  return c ? decodeURIComponent(c[1]) : '';
}

/**
 * 校验会话并返回身份与额度。
 * @returns {Promise<{ok:true, tier:'registered', userId:string, organizationId?:string, credits:number, creditsKnown:boolean}
 *                  | {ok:false, status:number, code:string, message:string}>}
 */
export async function verifySession(req) {
  const token = sessionTokenOf(req);
  if (!token) {
    return { ok: false, status: 401, code: 'LOGIN_REQUIRED', message: 'AI 功能需要登录后使用' };
  }
  if (!AUTH_BASE) {
    if (!REQUIRE_AUTH) {
      // 本地开发：明确标注绕过，绝不静默放行
      return { ok: true, tier: 'registered', userId: 'local-dev', credits: Number.MAX_SAFE_INTEGER, creditsKnown: false, authBypassed: true };
    }
    return { ok: false, status: 503, code: 'BACKEND_NOT_CONNECTED', message: '鉴权服务未配置（EZPLM_AUTH_BASE），AI 功能暂不可用' };
  }
  try {
    const { res, json } = await fetchUpstream(`${AUTH_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 8000, maxResponseBytes: 256 * 1024, as: 'json',
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: 401, code: 'LOGIN_REQUIRED', message: '登录已失效，请重新登录' };
    }
    if (!res.ok) return { ok: false, status: 502, code: 'AUTH_UPSTREAM_ERROR', message: '鉴权服务暂时不可用' };
    const d = json?.data ?? json ?? {};
    if (!d.userId && !d.id) return { ok: false, status: 401, code: 'LOGIN_REQUIRED', message: '会话无效' };
    return {
      ok: true, tier: 'registered',
      userId: String(d.userId ?? d.id),
      organizationId: d.organizationId ? String(d.organizationId) : undefined,
      credits: typeof d.credits === 'number' ? d.credits : 0,
      creditsKnown: typeof d.credits === 'number',
    };
  } catch (e) {
    const msg = e instanceof UpstreamError ? e.message : String(e?.message ?? e);
    return { ok: false, status: 502, code: 'AUTH_UPSTREAM_ERROR', message: `鉴权失败：${msg}` };
  }
}

/**
 * 扣费。账本在 ezPLM 侧 —— 我们不在本地记账，否则多实例之间对不上。
 * 扣费失败（余额不足/端点缺失）必须阻断调用，不能"先用了再说"。
 */
export async function consumeCredits(req, { capability, cost, userId }) {
  if (!AUTH_BASE) {
    return REQUIRE_AUTH
      ? { ok: false, status: 503, code: 'BACKEND_NOT_CONNECTED', message: 'Credit 服务未配置' }
      : { ok: true, remaining: null, bypassed: true };
  }
  const token = sessionTokenOf(req);
  try {
    const { res, json } = await fetchUpstream(`${AUTH_BASE}/credits/consume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability, cost, userId }),
      timeoutMs: 8000, maxResponseBytes: 64 * 1024, as: 'json',
    });
    if (res.status === 402) return { ok: false, status: 402, code: 'INSUFFICIENT_CREDITS', message: 'Credit 余额不足，请购买后继续' };
    if (res.status === 404) return { ok: false, status: 503, code: 'BACKEND_NOT_CONNECTED', message: 'Credit 扣费端点尚未提供' };
    if (!res.ok) return { ok: false, status: 502, code: 'CREDIT_UPSTREAM_ERROR', message: 'Credit 服务暂时不可用' };
    return { ok: true, remaining: typeof json?.remaining === 'number' ? json.remaining : null };
  } catch (e) {
    return { ok: false, status: 502, code: 'CREDIT_UPSTREAM_ERROR', message: String(e?.message ?? e).slice(0, 120) };
  }
}

/**
 * AI 端点统一入口：校验会话 → 扣费。任一步失败都返回可直接下发的错误体。
 * @returns {Promise<{ok:true, identity:object, remaining:number|null} | {ok:false, status:number, body:object}>}
 */
export async function requireAiAccess(req, capability, cost) {
  const sess = await verifySession(req);
  if (!sess.ok) {
    return { ok: false, status: sess.status, body: { error: sess.message, code: sess.code, capability } };
  }
  const charge = await consumeCredits(req, { capability, cost, userId: sess.userId });
  if (!charge.ok) {
    return { ok: false, status: charge.status, body: { error: charge.message, code: charge.code, capability, cost } };
  }
  return { ok: true, identity: sess, remaining: charge.remaining ?? null };
}

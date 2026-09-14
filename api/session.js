/**
 * api/session.js
 * 前端查询当前会话与 Credit 余额。只读，不签发会话。
 * 未登录返回 tier=anonymous（200，不是错误 —— 未登录是正常状态）。
 */
import { verifySession } from './_lib/session.js';
import { acquire, deny } from './_lib/guard.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const lease = acquire(req, 'session');
  if (!lease.ok) return deny(res, lease);
  try {
    const s = await verifySession(req);
    if (!s.ok) {
      // 未登录是正常状态；后端未接通则如实告知，不伪装成已登录
      return res.status(200).send(JSON.stringify({
        tier: 'anonymous',
        backendConnected: s.code !== 'BACKEND_NOT_CONNECTED',
        reason: s.code,
      }));
    }
    return res.status(200).send(JSON.stringify({
      tier: 'registered',
      userId: s.userId,
      organizationId: s.organizationId,
      credits: s.credits,
      creditsKnown: s.creditsKnown,
      authBypassed: s.authBypassed === true,
    }));
  } finally {
    lease.release();
  }
}

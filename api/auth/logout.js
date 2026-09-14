/**
 * api/auth/logout.js
 * 退出登录：清除本站会话 Cookie。
 *
 * 目前会话由 ezPLM / EEHub 签发（ezplm_session / eehub_session），本站只校验不签发；
 * 待 Session Bridge（§1）落地后，这里同时清除 proto_session。
 * 上游的登出（让 ezPLM 侧会话失效）不在本端点范围 —— 那需要 AUTH_LOGOUT_URL，未配置时不伪装。
 */
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).send(JSON.stringify({ error: 'POST only' }));
  const expire = (name) => `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  res.setHeader('Set-Cookie', [expire('proto_session'), expire('ezplm_session'), expire('eehub_session')]);
  const upstream = (process.env.AUTH_LOGOUT_URL ?? '').trim();
  return res.status(200).send(JSON.stringify({ ok: true, upstreamLogoutUrl: upstream || null }));
}

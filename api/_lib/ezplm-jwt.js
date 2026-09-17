/**
 * api/_lib/ezplm-jwt.js — ds2kicad 上游鉴权用的短期 JWT。
 * 从 api/ds2kicad.js 抽出，供 part.extract 执行器共用。
 */
import { createHmac } from 'node:crypto';

export function signJwt(secret) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: 'HS256', typ: 'JWT' });
  // sub/tenantId 是 DS2KiCad 侧登记的**租户标识**，改了对方就认不出来（LEGACY_COMPAT_IDENTIFIER）
  const p = b64u({ sub: 'circuit-canvas', name: '硬件原型工坊', tenantId: 'circuit-canvas', iat: now, exp: now + 300 });
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

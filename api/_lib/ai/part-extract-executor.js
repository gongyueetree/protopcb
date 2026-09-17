/**
 * api/_lib/ai/part-extract-executor.js
 * part.extract 的服务端执行器：一个操作、一套计费、一个 usage。
 *
 * 此前的分叉在前端：PDF/URL 先直连 /api/ds2kicad，成功就 0 Credit，失败回落 Gemini 才扣 4。
 * 而 ds2kicad 自己就是"确定性解析 + AI"，于是同一次提取的价格取决于后台是否可用 ——
 * 用户无法预期，计费口径也说不通。现在两条路径都在服务端、走同一次扣费。
 *
 * 优先级：PDF/URL → DS2KiCad（确定性解析，精度更高）→ 失败回落 Gemini；
 *        image/text → Gemini。
 */
import { fetchUpstream } from '../net.js';
import { signJwt } from '../ezplm-jwt.js';

const ds2Base = () => (process.env.DS2KICAD_URL ?? '').trim().replace(/\/+$/, '');

/** DS2KiCad 是否可用（未配置则整条路径跳过，不影响 Gemini 兜底） */
export function ds2Available() {
  return !!ds2Base();
}

/**
 * 调 DS2KiCad 的 /api/extract。
 * @returns {Promise<{ ok: true, data: object } | { ok: false, reason: string }>}
 */
export async function runDs2Extract(payload) {
  const base = ds2Base();
  if (!base) return { ok: false, reason: 'DS2KICAD_URL 未配置' };
  const secret = (process.env.EZPLM_JWT_SECRET ?? '').trim();
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers.Authorization = `Bearer ${signJwt(secret)}`;
  try {
    const { res, text } = await fetchUpstream(`${base}/api/extract`, {
      method: 'POST', headers, body: JSON.stringify(payload), as: 'text', timeoutMs: 60_000,
    });
    if (!res.ok) return { ok: false, reason: `ds2kicad HTTP ${res.status}` };
    const data = JSON.parse(text);
    // 演示模式（对方没配 Key）产出的是示例数据，不能当成功
    if (data?.mock) return { ok: false, reason: 'ds2kicad 处于演示模式' };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
  }
}

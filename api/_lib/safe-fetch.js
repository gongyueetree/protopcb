/**
 * api/_lib/safe-fetch.js —— 防 SSRF 的服务端抓取
 *
 * 服务端按用户给的 URL 去 fetch，是典型的 SSRF 面：攻击者可借此访问
 * 内网服务、云厂商元数据端点（169.254.169.254 常见于取云凭证）、本机端口。
 *
 * 因此每一跳都要校验，而不是只校验用户最初给的那个 URL：
 * DNS 解析出的真实 IP 也要判，重定向后的新目标要重新判。
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

/** 私网 / 环回 / 链路本地 / 元数据地址 —— 一律禁止 */
function isBlockedIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                     // 0.0.0.0/8
  if (a === 10) return true;                    // RFC1918
  if (a === 127) return true;                   // 环回
  if (a === 169 && b === 254) return true;      // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  if (a === 192 && b === 0) return true;        // 192.0.0.0/24 IETF
  if (a >= 224) return true;                    // 组播 / 保留
  return false;
}

function isBlockedIPv6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::' || s === '::1') return true;               // 未指定 / 环回
  if (s.startsWith('fe80')) return true;                    // 链路本地
  if (/^f[cd]/.test(s)) return true;                        // 唯一本地地址 fc00::/7
  if (s.startsWith('::ffff:')) {                            // IPv4 映射
    const v4 = s.slice(7);
    return net.isIPv4(v4) ? isBlockedIPv4(v4) : true;
  }
  if (s.startsWith('ff')) return true;                      // 组播
  return false;
}

export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true;   // 解析不出的一律拒绝
}

/** 校验单个 URL：协议白名单 + 主机名解析后的 IP 判定 */
export async function assertSafeUrl(rawUrl, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('URL 格式无效'); }

  const allowed = allowHttp ? ['http:', 'https:'] : ['https:'];
  if (!allowed.includes(u.protocol)) {
    throw new Error(`仅支持 ${allowed.join(' / ')} 协议`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$/i.test(host) || /\.local$/i.test(host) || /\.internal$/i.test(host)) {
    throw new Error('不允许访问本机或内网地址');
  }
  // 字面量 IP 直接判；域名先解析再判（防 DNS rebinding 的第一道）
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('目标地址位于内网或保留网段，已拒绝');
    return u;
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error('域名解析失败');
  }
  if (!addrs.length) throw new Error('域名解析失败');
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) throw new Error('目标域名解析到内网地址，已拒绝');
  }
  return u;
}

/**
 * 安全抓取：手动跟随重定向，每一跳都重新校验；限制大小、超时、内容类型。
 * @returns {Promise<{ buffer: Buffer, contentType: string, url: string }>}
 */
export async function safeFetch(rawUrl, {
  allowHttp = false,
  maxBytes = 8 * 1024 * 1024,
  timeoutMs = 15000,
  maxRedirects = 3,
  allowedContentTypes = null,   // 例如 [/^application\/pdf/]
  headers = {},
} = {}) {
  let target = await assertSafeUrl(rawUrl, { allowHttp });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await fetch(target.toString(), {
        redirect: 'manual',          // 自己跟随，才能逐跳校验
        signal: ctl.signal,
        headers: { 'User-Agent': 'protopcb/1.0', ...headers },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('重定向缺少 Location');
        if (hop === maxRedirects) throw new Error('重定向次数过多');
        target = await assertSafeUrl(new URL(loc, target).toString(), { allowHttp });
        continue;
      }

      if (!res.ok) throw new Error(`目标返回 HTTP ${res.status}`);

      const ct = res.headers.get('content-type') ?? '';
      if (allowedContentTypes && !allowedContentTypes.some((re) => re.test(ct))) {
        throw new Error(`内容类型不被允许：${ct.split(';')[0] || '未知'}`);
      }

      // Content-Length 先挡一道，再按流累计（对方可能不给或谎报）
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared && declared > maxBytes) {
        throw new Error(`内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
      }

      const chunks = [];
      let total = 0;
      const reader = res.body?.getReader();
      if (!reader) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) throw new Error('内容超过大小上限');
        return { buffer: buf, contentType: ct, url: target.toString() };
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
        }
        chunks.push(value);
      }
      return { buffer: Buffer.concat(chunks), contentType: ct, url: target.toString() };
    }
    throw new Error('重定向次数过多');
  } finally {
    clearTimeout(timer);
  }
}

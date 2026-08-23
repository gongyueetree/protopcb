import { acquire, checkBodySize, deny } from './_lib/guard.js';
import { safeFetch } from './_lib/safe-fetch.js';
import { fetchUpstream, UpstreamError } from './_lib/net.js';
/**
 * api/ezplm.js — Vercel Serverless Function：ezPLM API Key 签名代理
 *
 * 为什么需要代理：ezPLM 采用 HMAC-SHA256 请求签名，API Key 既是身份也是签名密钥。
 * 前端 VITE_ 环境变量会被打进浏览器 bundle（公开可见），Key 绝不能放前端。
 * 本函数在服务端持有 EZPLM_API_KEY（Vercel → Settings → Environment Variables，
 * 变量名不带 VITE_ 前缀 → 不会进入前端构建产物），完成签名后转发请求，同时规避 CORS。
 *
 * 签名规则（与官方 demo 一致）：
 *   canonical = METHOD \n PATH \n 按key字典序排序的query \n X-Timestamp \n X-Nonce
 *   X-Signature = base64url( HMAC-SHA256( API_KEY, canonical ) )
 *
 * 前端调用：
 *   GET /api/ezplm?path=status                                  → { configured: boolean }（不消耗上游配额）
 *   GET /api/ezplm?path=parts&keyword=STM32&pageSize=20         → 透传 ezPLM 响应
 *   GET /api/ezplm?path=reference-designs&partlibId=xxx         → 透传 ezPLM 响应
 */
import crypto from 'node:crypto';

const BASE_URL = 'https://www.ezplm.cn';
const ALLOWED_PATHS = new Set(['parts', 'reference-designs']);

/** 与官方 demo 相同的 query 规范化：过滤空值 → 字典序排序 → encodeURIComponent 拼接 */
export function canonicalQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => [String(key), String(Array.isArray(value) ? value[0] : value)])
    .sort(([lk, lv], [rk, rv]) => (lk === rk ? lv.localeCompare(rv) : lk.localeCompare(rk)))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

/** 计算签名（导出以便测试） */
export function buildSignature({ apiKey, method, path, params, timestamp, nonce }) {
  const canonical = [method.toUpperCase(), path, canonicalQuery(params), timestamp, nonce].join('\n');
  return crypto.createHmac('sha256', apiKey).update(canonical).digest('base64url');
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 配额防护：这些接口消耗自有 API 额度，需限制频率/并发/体积
  const sizeCheck = checkBodySize(req);
  if (!sizeCheck.ok) return deny(res, sizeCheck);
  const lease = acquire(req, 'ezplm');
  if (!lease.ok) return deny(res, lease);
  try {
  const { path, ...params } = req.query ?? {};
  const apiKey = (process.env.EZPLM_API_KEY ?? '').trim() || undefined;

  // 状态探测：不打上游，不耗配额
  if (path === 'status') {
    return res.status(200).send(JSON.stringify({ configured: !!apiKey }));
  }
  // 库文件拉取：footprint/symbol/step 等文件链接（规避浏览器 CORS）
  // 加固点：
  //  1) host 白名单收紧 —— 只放行 ezPLM 自有域 + 实际使用的 ezPLM 存储桶（EZPLM_FILE_HOSTS
  //     环境变量精确指定，如 "ezplm-lib.oss-cn-shanghai.aliyuncs.com"）。
  //     不再整个 *.aliyuncs.com / *.myqcloud.com / *.amazonaws.com 放开：任何人都能在
  //     这些公有云上开桶，旧白名单等于把代理开成通用文件中转。
  //     未配置 EZPLM_FILE_HOSTS 时回落到旧的 provider 通配（并 WARN），避免破坏现网功能。
  //  2) safeFetch 全程接管：每跳重定向重新校验、流式大小上限、超时。
  //  3) 只允许 EDA 资产类文件（按扩展名/内容类型粗校验），Content-Disposition 文件名净化。
  if (path === 'file') {
    const fileUrl = String(req.query.url ?? '');
    let u;
    try { u = new URL(fileUrl); } catch { return res.status(400).send(JSON.stringify({ error: 'invalid url' })); }
    const host = u.hostname;
    const exactHosts = (process.env.EZPLM_FILE_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const isEzplm = /(^|[.])ezplm[.](cn|com)$/.test(host);
    let okHost;
    if (exactHosts.length) {
      okHost = isEzplm || exactHosts.includes(host.toLowerCase());
    } else {
      okHost = isEzplm || /[.]aliyuncs[.]com$/.test(host) || /[.]myqcloud[.]com$/.test(host) || /[.]amazonaws[.]com$/.test(host);
      if (okHost && !isEzplm) console.warn('[ezplm/file] EZPLM_FILE_HOSTS 未配置，正在使用宽泛云存储通配白名单（建议配置精确 bucket host）');
    }
    if (!okHost) return res.status(403).send(JSON.stringify({ error: 'host not allowed', host }));
    // 文件类型：仅 EDA 资产（路径扩展名判断；CDN 签名 query 不参与）
    const extOk = /\.(kicad_mod|kicad_sym|kicad_pcb|kicad_sch|lib|dcm|mod|sym|step|stp|wrl|pdf|png|jpe?g|svg|zip|json)$/i.test(u.pathname);
    if (!extOk) return res.status(415).send(JSON.stringify({ error: 'file type not allowed', path: u.pathname.slice(-40) }));
    try {
      const { buffer, contentType } = await safeFetch(fileUrl, {
        headers: apiKey ? { 'X-API-Key': apiKey } : {},
        maxBytes: 32 * 1024 * 1024,   // STEP 模型可较大；仍需上限防止内存耗尽
        timeoutMs: 25_000,
        maxRedirects: 3,              // 每跳都经 assertSafeUrl 重新校验（safeFetch 内部）
      });
      res.status(200);
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      // dl 参数：作为附件下载；文件名净化（去控制字符/引号/路径分隔，RFC5987 编码）
      if (req.query.dl) {
        // eslint-disable-next-line no-control-regex -- 有意过滤控制字符（文件名净化）
        const raw = String(req.query.dl).replace(/[\x00-\x1f"\\/]+/g, '_').slice(0, 120) || 'download';
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(raw)}`);
      }
      return res.send(buffer);
    } catch (err) {
      return res.status(502).send(JSON.stringify({ error: 'file fetch failed', detail: String(err?.message ?? err).slice(0, 160) }));
    }
  }

  if (!apiKey) {
    return res.status(501).send(JSON.stringify({ error: 'EZPLM_API_KEY not configured', hint: 'Vercel → Settings → Environment Variables 添加 EZPLM_API_KEY 后 Redeploy' }));
  }
  if (!ALLOWED_PATHS.has(path)) {
    return res.status(400).send(JSON.stringify({ error: 'invalid path', allowed: [...ALLOWED_PATHS, 'status'] }));
  }

  const apiPath = `/api/v1/api-key/${path}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const signature = buildSignature({ apiKey, method: 'GET', path: apiPath, params, timestamp, nonce });
  const query = canonicalQuery(params);
  const url = query ? `${BASE_URL}${apiPath}?${query}` : `${BASE_URL}${apiPath}`;

  try {
    // 统一出站通道：超时 + 响应体上限（ezPLM 列表接口正常远小于该值）
    const { res: upstream, text } = await fetchUpstream(url, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature },
      timeoutMs: 20_000,
      maxResponseBytes: 4 * 1024 * 1024,
      as: 'text',
    });
    res.status(upstream.status);
    try { JSON.parse(text); res.send(text); } catch { res.send(JSON.stringify({ raw: text.slice(0, 2000) })); }
  } catch (err) {
    const status = err instanceof UpstreamError && err.kind === 'timeout' ? 504 : 502;
    res.status(status).send(JSON.stringify({ error: 'upstream fetch failed', detail: String(err?.message ?? err).slice(0, 160) }));
  }
  } finally {
    lease.release();
  }
}

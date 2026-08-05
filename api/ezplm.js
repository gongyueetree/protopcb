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
  const { path, ...params } = req.query ?? {};
  const apiKey = process.env.EZPLM_API_KEY;

  // 状态探测：不打上游，不耗配额
  if (path === 'status') {
    return res.status(200).send(JSON.stringify({ configured: !!apiKey }));
  }
  // 库文件拉取：footprint/symbol/step 等文件链接（规避浏览器 CORS）；仅允许可信域
  if (path === 'file') {
    const fileUrl = String(req.query.url ?? '');
    let host = '';
    try { host = new URL(fileUrl).hostname; } catch { return res.status(400).send(JSON.stringify({ error: 'invalid url' })); }
    const okHost = /(^|[.])ezplm[.]cn$/.test(host) || /[.]aliyuncs[.]com$/.test(host) || /[.]myqcloud[.]com$/.test(host) || /[.]amazonaws[.]com$/.test(host);
    if (!okHost) return res.status(403).send(JSON.stringify({ error: 'host not allowed', host }));
    try {
      const f = await fetch(fileUrl, { headers: apiKey ? { 'X-API-Key': apiKey } : {} });
      const buf = Buffer.from(await f.arrayBuffer());
      res.status(f.status);
      res.setHeader('Content-Type', f.headers.get('content-type') ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    } catch (err) {
      return res.status(502).send(JSON.stringify({ error: 'file fetch failed', detail: String(err) }));
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
    const upstream = await fetch(url, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature },
    });
    const text = await upstream.text();
    res.status(upstream.status);
    try { JSON.parse(text); res.send(text); } catch { res.send(JSON.stringify({ raw: text })); }
  } catch (err) {
    res.status(502).send(JSON.stringify({ error: 'upstream fetch failed', detail: String(err) }));
  }
}

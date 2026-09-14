import { acquire, checkBodySize, deny } from './_lib/guard.js';
import { requireAuthenticatedCapability } from './_lib/session.js';
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

/**
 * api/digikey.js — Vercel Serverless Function：DigiKey ProductInformation V4 代理
 *
 * Client Secret 必须留在服务端（同 ezPLM Key 的理由）。Vercel 环境变量：
 *   DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET（不带 VITE_ 前缀）
 * 可选：DIGIKEY_LOCALE_SITE(默认 CN) / DIGIKEY_LOCALE_CURRENCY(默认 CNY) / DIGIKEY_LOCALE_LANGUAGE(默认 zhs)
 *
 * 前端调用：
 *   GET /api/digikey?path=status          → { configured }
 *   GET /api/digikey?path=price&mpn=XXX   → { found, unitPrice, currency, stock, productUrl, digikeyPn, description }
 */

const TOKEN_URL = 'https://api.digikey.com/v1/oauth2/token';
const SEARCH_URL = 'https://api.digikey.com/products/v4/search/keyword';

// token 缓存（serverless 热实例内复用；DigiKey token 约 10 分钟有效）
let tokenCache = { token: null, expiresAt: 0 };

async function getToken(clientId, clientSecret) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 30_000) return tokenCache.token;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
  const r = await tfetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 600) * 1000 };
  return tokenCache.token;
}

/** 防御式提取首个商品的价格/库存/链接（V4 结构） */
function mapProduct(p) {
  if (!p) return { found: false };
  const variation = Array.isArray(p.ProductVariations) ? p.ProductVariations[0] : undefined;
  const breaks = variation?.StandardPricing ?? p.StandardPricing ?? [];
  const firstBreak = Array.isArray(breaks) && breaks.length ? breaks[0] : undefined;
  const unitPrice = typeof p.UnitPrice === 'number' && p.UnitPrice > 0 ? p.UnitPrice
    : typeof firstBreak?.UnitPrice === 'number' ? firstBreak.UnitPrice : undefined;
  return {
    found: true,
    unitPrice,
    stock: typeof p.QuantityAvailable === 'number' ? p.QuantityAvailable : undefined,
    productUrl: typeof p.ProductUrl === 'string' ? p.ProductUrl : undefined,
    digikeyPn: variation?.DigiKeyProductNumber ?? p.DigiKeyProductNumber ?? undefined,
    photoUrl: typeof p.PhotoUrl === 'string' && p.PhotoUrl ? p.PhotoUrl : undefined,
    description: p.Description?.ProductDescription ?? p.ProductDescription ?? undefined,
    manufacturer: p.Manufacturer?.Name ?? undefined,
  };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 配额防护：这些接口消耗自有 API 额度，需限制频率/并发/体积
  const sizeCheck = checkBodySize(req);
  if (!sizeCheck.ok) return deny(res, sizeCheck);
  const lease = acquire(req, 'digikey');
  if (!lease.ok) return deny(res, lease);
  try {
  const { path, mpn } = req.query ?? {};
  const clientId = (process.env.DIGIKEY_CLIENT_ID ?? '').trim() || undefined;
  const clientSecret = (process.env.DIGIKEY_CLIENT_SECRET ?? '').trim() || undefined;

  if (path === 'status') {
    return res.status(200).send(JSON.stringify({ configured: !!(clientId && clientSecret) }));
  }

  // ── 账户门禁（不扣 Credit）：除 status 外都消耗平台的分销商 Key，匿名一律 401，
  //    且必须在任何上游调用之前 —— 匿名直接 curl 这个接口也拿不到数据 ──
  {
    const gate = await requireAuthenticatedCapability(req, 'search.web');
    if (!gate.ok) {
      if (typeof lease !== 'undefined' && lease?.release) lease.release();
      return res.status(gate.status).send(JSON.stringify(gate.body));
    }
  }
  if (!clientId || !clientSecret) {
    return res.status(501).send(JSON.stringify({ error: 'DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET not configured' }));
  }
  /**
   * path=fuzzy —— 关键词检索（供 BOM「查找相近」使用）。
   * 与 path=price 的区别：price 只接受厂商料号**精确匹配**（价格张冠李戴代价高）；
   * 这里是用户主动要看的候选列表，返回多条并由前端打分排序、由用户确认，
   * 因此允许关键词命中，但每条都标出真实 MPN 供核对。
   */
  if (path === 'fuzzy') {
    const kw = String(req.query?.q ?? mpn ?? '').trim().slice(0, 120);
    if (!kw) return res.status(400).send(JSON.stringify({ error: 'usage: ?path=fuzzy&q=keywords' }));
    try {
      const token = await getToken(clientId, clientSecret);
      const reqCur = String(req.query?.currency ?? '').toUpperCase();
      const currency = /^[A-Z]{3}$/.test(reqCur) ? reqCur : (process.env.DIGIKEY_LOCALE_CURRENCY ?? 'CNY');
      const site = currency === 'USD' ? 'US' : (process.env.DIGIKEY_LOCALE_SITE ?? 'CN');
      const language = currency === 'USD' ? 'en' : (process.env.DIGIKEY_LOCALE_LANGUAGE ?? 'zhs');
      const r = await tfetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-DIGIKEY-Client-Id': clientId,
          'X-DIGIKEY-Locale-Site': site,
          'X-DIGIKEY-Locale-Currency': currency,
          'X-DIGIKEY-Locale-Language': language,
        },
        body: JSON.stringify({ Keywords: kw, Limit: 10, Offset: 0 }),
      });
      if (!r.ok) return res.status(200).send(JSON.stringify({ items: [], message: `DigiKey HTTP ${r.status}` }));
      const j = await r.json();
      const items = (Array.isArray(j?.Products) ? j.Products : []).slice(0, 10).map((p) => {
        const m = mapProduct(p);
        return {
          vendor: 'DigiKey', mpn: p?.ManufacturerProductNumber ?? '',
          manufacturer: p?.Manufacturer?.Name ?? '', description: p?.Description?.ProductDescription ?? '',
          price: m.unitPrice, currency, stock: m.stock, url: m.productUrl,
        };
      }).filter((x) => x.mpn);
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(200).send(JSON.stringify({ items }));
    } catch (e) {
      return res.status(200).send(JSON.stringify({ items: [], message: String(e?.message ?? e).slice(0, 120) }));
    }
  }

  if (path !== 'price' || !mpn) {
    return res.status(400).send(JSON.stringify({ error: 'usage: ?path=price&mpn=XXX' }));
  }

  try {
    const token = await getToken(clientId, clientSecret);
    // 币种由调用方指定（界面语言决定），未指定则用环境变量/CNY。
    // 关键：这是向 DigiKey **请求对应币种的真实报价**，不是把人民币数值换个符号。
    const reqCur = String(req.query?.currency ?? '').toUpperCase();
    const currency = /^[A-Z]{3}$/.test(reqCur) ? reqCur : (process.env.DIGIKEY_LOCALE_CURRENCY ?? 'CNY');
    const site = currency === 'USD' ? 'US' : (process.env.DIGIKEY_LOCALE_SITE ?? 'CN');
    const language = currency === 'USD' ? 'en' : (process.env.DIGIKEY_LOCALE_LANGUAGE ?? 'zhs');
    const r = await tfetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-DIGIKEY-Client-Id': clientId,
        'X-DIGIKEY-Locale-Site': site,
        'X-DIGIKEY-Locale-Currency': currency,
        'X-DIGIKEY-Locale-Language': language,
      },
      body: JSON.stringify({ Keywords: String(mpn), Limit: 3, Offset: 0 }),
    });
    if (!r.ok) {
      return res.status(r.status).send(JSON.stringify({ error: `digikey ${r.status}`, detail: (await r.text()).slice(0, 300) }));
    }
    const j = await r.json();
    const products = Array.isArray(j?.Products) ? j.Products : [];
    // 仅接受厂商料号精确匹配：关键词搜索会返回无关器件，其图片/价格若采用会张冠李戴
    const norm = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const target = norm(mpn);
    // 严格相等（去分隔符）；前缀近似曾把演示位号撞到真实贵价料 → 一律不做近似
    const exact = products.find((p) => norm(p?.ManufacturerProductNumber) === target);
    const out = exact ? mapProduct(exact) : { found: false };
    out.currency = currency;
    // 缓存 10 分钟（价格/库存时效性数据）
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.status(200).send(JSON.stringify(out));
  } catch (err) {
    return res.status(502).send(JSON.stringify({ error: 'digikey request failed', detail: String(err).slice(0, 300) }));
  }
  } finally {
    lease.release();
  }
}

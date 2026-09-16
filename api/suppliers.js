import { acquire, checkBodySize, deny } from './_lib/guard.js';
import { requireAuthenticatedCapability } from './_lib/session.js';
import { fetchWithTimeout, readResponseLimited } from './_lib/net.js';
import { buildIceasyAuth, mapIceasyRows, buildOuricRequestBody, mapOuricData } from './_lib/vendor-auth.js';
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
 * api/suppliers.js — 供应商价格/库存聚合代理（Mouser / Arrow / element14）
 *
 * Vercel 环境变量（服务端专用，不带 VITE_ 前缀）：
 *   MOUSER_API_KEY                      — Mouser Search API
 *   ARROW_LOGIN + ARROW_API_KEY         — Arrow ItemService（两个都要）
 *   ELEMENT14_API_KEY                   — element14/Farnell Product Search
 *   B1B_API_KEY                         — 百芯（NOT_CONNECTED：无真实 API contract，配置了也不会调用）
 *   ICEASY_ACCOUNT + ICEASY_PASSWORD    — Iceasy 接口账号/密码（两个都要；按 2026-09-11 对接文档实现）
 *   ICEASY_PRODUCT_DETAIL_URL           — 可选，默认 https://www.iceasy.com/api/ezplm/product/list
 *   OURIC_API_KEY + OURIC_API_SECRET    — OURIC 开放 API 双密钥（两个都要；按 v1.0 对接文档实现）
 *   OURIC_PRODUCTS_URL                  — 可选，默认 https://manage.ouric.uk/admin/openapi/products
 *
 * GET /api/suppliers?path=status → { mouser, arrow, element14 }（各自是否已配置）
 * GET /api/suppliers?mpn=XXX     → { offers: [{vendor, configured, found, price, currency, stock, url}] }
 *
 * 注意：Arrow/element14 的响应映射按公开文档编写，属防御式实现；
 * 你申请到 Key 后首次调用如字段有偏差，只需校准本文件对应的 mapXxx 函数。
 */

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : undefined; };

/* ---------- 国产渠道 ----------
 * 中电港（CECPORT）已更名为 Iceasy，真实对接见下方 queryIceasy（有官方文档与固定校验样例）。
 * 原先那段基于猜测端点 api.cecport.com 的骨架已删除 —— 猜的端点连不通，留着只会误导。
 * 百芯（B1B）无真实 contract，见 queryB1b —— 明确 NOT_CONNECTED，不猜端点。 */
/**
 * 百芯（B1B）：尚无真实 API contract（端点/鉴权/响应结构都未拿到）。
 * 不在生产路径上猜 URL —— 猜的端点连不通，还会把"查询失败"误报成渠道故障。
 * 拿到官方文档后再实现；在此之前明确返回 NOT_CONNECTED。
 */
async function queryB1b() {
  return { found: false, notConnected: true, reason: 'B1B_API_CONTRACT_NOT_AVAILABLE' };
}

/* ---------- Iceasy（真实对接：iceasy-api-integration.md 2026-09-11）---------- */
async function queryIceasy(account, password, mpn) {
  const endpoint = (process.env.ICEASY_PRODUCT_DETAIL_URL ?? '').trim() || 'https://www.iceasy.com/api/ezplm/product/list';
  const { date, key } = buildIceasyAuth(account, password);       // 每次请求重新生成（文档 3.2）
  // 表单编码必须用 URLSearchParams：Base64 的 + / = 手拼会被解析成空格（文档第 2 节）
  const body = new URLSearchParams({ partNoList: mpn, account, date, key });
  const r = await tfetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeoutMs: 5_000,                                              // 文档示例口径；含响应体读取
  });
  if (!r.ok) throw new Error(`iceasy HTTP ${r.status}`);
  const j = await r.json();
  // 文档第 6 节：rows 缺失/类型错误 ≠ 空结果，需按格式异常处理，不能断定料号不存在
  if (!Array.isArray(j?.data?.rows)) throw new Error('iceasy 响应缺少 data.rows（需核对业务状态或格式）');
  return mapIceasyRows(j.data.rows, mpn);
}

/* ---------- OURIC（真实对接：OURIC_API对接文档 v1.0）---------- */
async function queryOuric(apiKey, apiSecret, mpn) {
  const endpoint = (process.env.OURIC_PRODUCTS_URL ?? '').trim() || 'https://manage.ouric.uk/admin/openapi/products';
  const body = buildOuricRequestBody(apiKey, apiSecret, { partNumber: mpn, pageNum: 1, pageSize: 10 });
  const r = await tfetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 8_000,
  });
  if (!r.ok) throw new Error(`ouric HTTP ${r.status}`);
  const j = await r.json();
  if (j?.success !== true) throw new Error(`ouric 业务失败：${String(j?.code ?? '')} ${String(j?.message ?? '')}`.slice(0, 100));
  return mapOuricData(j?.data, mpn);
}

/* ---------- Mouser ---------- */
async function queryMouser(key, mpn) {
  const r = await tfetch(`https://api.mouser.com/api/v1/search/keyword?apiKey=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ SearchByKeywordRequest: { keyword: mpn, records: 3, startingRecord: 0 } }),
  });
  if (!r.ok) throw new Error(`mouser ${r.status}`);
  const j = await r.json();
  const parts = j?.SearchResults?.Parts ?? [];
  const exact = parts.find((p) => String(p?.ManufacturerPartNumber ?? '').toUpperCase() === mpn.toUpperCase());
  if (!exact) return { found: false, note: 'no exact match' };   // 模糊命中不作数：错型号的价格比没有价格更有害
  const brk = (exact.PriceBreaks ?? [])[0];
  return {
    found: true,
    price: num(brk?.Price),
    currency: brk?.Currency ?? 'CNY',
    stock: num(exact.AvailabilityInStock ?? exact.Availability),
    url: exact.ProductDetailUrl || `https://www.mouser.cn/c/?q=${encodeURIComponent(mpn)}`,
  };
}

/* ---------- Arrow（防御式，拿到 Key 后可能需按真实响应校准） ---------- */
async function queryArrow(login, key, mpn) {
  const r = await tfetch(`https://api.arrow.com/itemservice/v4/en/search/token?login=${encodeURIComponent(login)}&apikey=${encodeURIComponent(key)}&search_token=${encodeURIComponent(mpn)}&rows=3`);
  if (!r.ok) throw new Error(`arrow ${r.status}`);
  const j = await r.json();
  const parts = j?.itemserviceresult?.data?.[0]?.PartList ?? [];
  const part = parts[0];
  if (!part) return { found: false };
  const src = (part.InvOrg?.webSites ?? []).flatMap((w) => w?.sources ?? []);
  const pd = src.flatMap((sc) => sc?.sourceParts ?? [])[0];
  const price = pd?.Prices?.resaleList?.[0]?.price ?? pd?.prices?.[0]?.price;
  const stock = pd?.Availability?.[0]?.fohQuantity;
  const arrowMpn = String(part?.partNum ?? part?.partNumber ?? part?.itemId ?? '').toUpperCase();
  if (arrowMpn && arrowMpn !== mpn.toUpperCase()) return { found: false, note: 'no exact match' };
  return {
    found: true,
    price: num(price),
    currency: 'USD',
    stock: num(stock),
    url: `https://www.arrow.com/en/products/search?q=${encodeURIComponent(mpn)}`,
  };
}

/* ---------- element14 / Farnell（防御式） ---------- */
async function queryElement14(key, mpn) {
  const url = `https://api.element14.com/catalog/products?term=manuPartNumber:${encodeURIComponent(mpn)}&storeInfo.id=cn.element14.com&resultsSettings.offset=0&resultsSettings.numberOfResults=3&resultsSettings.responseGroup=medium&callInfo.responseDataFormat=json&callInfo.apiKey=${encodeURIComponent(key)}`;
  const r = await tfetch(url);
  if (!r.ok) throw new Error(`element14 ${r.status}`);
  const j = await r.json();
  const products = j?.manufacturerPartNumberSearchReturn?.products ?? j?.keywordSearchReturn?.products ?? [];
  const p = products[0];
  if (!p) return { found: false };
  const e14Mpn = String(p?.translatedManufacturerPartNumber ?? p?.manufacturerPartNumber ?? '').toUpperCase();
  if (e14Mpn && e14Mpn !== mpn.toUpperCase()) return { found: false, note: 'no exact match' };
  return {
    found: true,
    price: num(p.prices?.[0]?.cost),
    currency: 'CNY',
    stock: num(p.stock?.level ?? p.inv),
    url: `https://cn.element14.com/search?st=${encodeURIComponent(mpn)}`,
  };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 配额防护：这些接口消耗自有 API 额度，需限制频率/并发/体积
  const sizeCheck = checkBodySize(req);
  if (!sizeCheck.ok) return deny(res, sizeCheck);
  const lease = acquire(req, 'suppliers');
  if (!lease.ok) return deny(res, lease);
  try {
  const { path, mpn } = req.query ?? {};
  const t = (v) => (v ?? '').trim() || undefined;
  const mouserKey = t(process.env.MOUSER_API_KEY);
  const arrowLogin = t(process.env.ARROW_LOGIN);
  const arrowKey = t(process.env.ARROW_API_KEY);
  const e14Key = t(process.env.ELEMENT14_API_KEY);
  const b1bKey = t(process.env.B1B_API_KEY);
  const iceasyAcc = t(process.env.ICEASY_ACCOUNT);
  const iceasyPwd = t(process.env.ICEASY_PASSWORD);
  const ouricKey = t(process.env.OURIC_API_KEY);
  const ouricSecret = t(process.env.OURIC_API_SECRET);

  if (path === 'status') {
    return res.status(200).send(JSON.stringify({ mouser: !!mouserKey, arrow: !!(arrowLogin && arrowKey), element14: !!e14Key, b1b: false /* NOT_CONNECTED：无 contract */, iceasy: !!(iceasyAcc && iceasyPwd), ouric: !!(ouricKey && ouricSecret) }));
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
  // ── 关键词检索：给"网络" Tab 用（返回候选列表，含封装描述供映射） ──
  if (path === 'search') {
    const q = String(req.query.q ?? '').trim();
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
    if (q.length < 2) return res.status(400).send(JSON.stringify({ error: 'query too short' }));
    const items = [];
    const notes = [];

    // Mouser 关键词检索
    if (mouserKey) {
      try {
        const r = await tfetch(`https://api.mouser.com/api/v1/search/keyword?apiKey=${encodeURIComponent(mouserKey)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ SearchByKeywordRequest: { keyword: q, records: limit, startingRecord: 0 } }),
        });
        if (r.ok) {
          const j = await r.json();
          for (const p2 of (j?.SearchResults?.Parts ?? []).slice(0, limit)) {
            const brk = (p2.PriceBreaks ?? [])[0];
            items.push({
              vendor: 'Mouser',
              mpn: p2.ManufacturerPartNumber ?? '',
              manufacturer: p2.Manufacturer ?? '',
              description: p2.Description ?? '',
              rawPackage: p2.Package ?? (p2.ProductAttributes ?? []).find((a) => /package|case/i.test(a?.AttributeName ?? ''))?.AttributeValue ?? '',
              price: num(brk?.Price), currency: brk?.Currency,
              stock: num(p2.AvailabilityInStock),
              url: p2.ProductDetailUrl, datasheetUrl: p2.DataSheetUrl,
              imageUrl: p2.ImagePath || p2.ImageURL || undefined,
            });
          }
        } else notes.push(`Mouser ${r.status}`);
      } catch (e) { notes.push(`Mouser ${String(e.message ?? e).slice(0, 60)}`); }
    }

    // DigiKey 关键词检索（复用 /api/digikey 的令牌逻辑；未配置则跳过）
    const dkId = t(process.env.DIGIKEY_CLIENT_ID), dkSecret = t(process.env.DIGIKEY_CLIENT_SECRET);
    if (dkId && dkSecret && items.length < limit) {
      try {
        const tk = await tfetch('https://api.digikey.com/v1/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `client_id=${encodeURIComponent(dkId)}&client_secret=${encodeURIComponent(dkSecret)}&grant_type=client_credentials`,
        });
        if (tk.ok) {
          const { access_token } = await tk.json();
          const r = await tfetch('https://api.digikey.com/products/v4/search/keyword', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}`, 'X-DIGIKEY-Client-Id': dkId, 'X-DIGIKEY-Locale-Site': 'CN', 'X-DIGIKEY-Locale-Currency': 'CNY' },
            body: JSON.stringify({ Keywords: q, Limit: limit, Offset: 0 }),
          });
          if (r.ok) {
            const j = await r.json();
            for (const p2 of (j?.Products ?? []).slice(0, limit)) {
              const pkgParam = (p2.Parameters ?? []).find((a) => /package|case/i.test(a?.ParameterText ?? a?.Parameter ?? ''));
              items.push({
                vendor: 'DigiKey',
                mpn: p2.ManufacturerProductNumber ?? p2.ManufacturerPartNumber ?? '',
                manufacturer: p2.Manufacturer?.Name ?? p2.Manufacturer?.Value ?? '',
                description: p2.Description?.ProductDescription ?? p2.ProductDescription ?? '',
                rawPackage: pkgParam?.ValueText ?? pkgParam?.Value ?? '',
                price: num(p2.UnitPrice ?? (p2.ProductVariations ?? [])[0]?.StandardPricing?.[0]?.UnitPrice),
                currency: 'CNY',
                stock: num(p2.QuantityAvailable),
                url: p2.ProductUrl, datasheetUrl: p2.DatasheetUrl,
                imageUrl: p2.PhotoUrl || undefined,
              });
            }
          } else notes.push(`DigiKey ${r.status}`);
        } else notes.push(`DigiKey token ${tk.status}`);
      } catch (e) { notes.push(`DigiKey ${String(e.message ?? e).slice(0, 60)}`); }
    }

    // 去重（同型号取首个）
    const seen = new Set();
    const uniq = items.filter((x) => {
      const k = String(x.mpn).toUpperCase();
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, limit);

    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.status(200).send(JSON.stringify({
      items: uniq,
      message: uniq.length ? undefined : (notes.length ? notes.join('; ') : (!mouserKey && !dkId ? '未配置 MOUSER_API_KEY / DIGIKEY_CLIENT_ID' : '无匹配结果')),
    }));
  }

  // ── 模糊候选：BOM 中无报价的行，由用户主动点击后按 型号/封装/值 综合检索 ──
  // 与自动估价不同，这里刻意放宽匹配，把候选交给用户判断（自动链路仍只认精确匹配）
  if (path === 'fuzzy') {
    const q = [req.query.mpn, req.query.value, req.query.footprint, req.query.desc]
      .map((x) => String(x ?? '').trim()).filter(Boolean).join(' ').slice(0, 120);
    if (!q) return res.status(400).send(JSON.stringify({ error: 'need mpn/value/footprint' }));
    const items = [];
    if (mouserKey) {
      try {
        const r = await tfetch(`https://api.mouser.com/api/v1/search/keyword?apiKey=${encodeURIComponent(mouserKey)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ SearchByKeywordRequest: { keyword: q, records: 8, startingRecord: 0 } }),
        });
        if (r.ok) {
          const j = await r.json();
          for (const p2 of (j?.SearchResults?.Parts ?? []).slice(0, 8)) {
            const brk = (p2.PriceBreaks ?? [])[0];
            if (!brk) continue;
            items.push({
              vendor: 'Mouser', mpn: p2.ManufacturerPartNumber ?? '', manufacturer: p2.Manufacturer ?? '',
              description: p2.Description ?? '', price: num(brk.Price), currency: brk.Currency,
              stock: num(p2.AvailabilityInStock), url: p2.ProductDetailUrl,
            });
          }
        }
      } catch { /* 忽略单一渠道失败 */ }
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(JSON.stringify({
      items,
      message: items.length ? undefined : (mouserKey ? '未找到相近器件' : '未配置 MOUSER_API_KEY'),
    }));
  }

  if (!mpn) return res.status(400).send(JSON.stringify({ error: 'usage: ?mpn=XXX' }));

  const jobs = [
    { vendor: 'Mouser', configured: !!mouserKey, run: () => queryMouser(mouserKey, String(mpn)) },
    // 国产现货渠道（真实对接，按各自文档实现；未配凭据时 configured=false 不发请求）
    { vendor: 'Iceasy', configured: !!(iceasyAcc && iceasyPwd), run: () => queryIceasy(iceasyAcc, iceasyPwd, String(mpn)) },
    { vendor: 'OURIC', configured: !!(ouricKey && ouricSecret), run: () => queryOuric(ouricKey, ouricSecret, String(mpn)) },
    // 预留骨架：配置 Key 后按真实响应字段校准 map 函数即可启用
    { vendor: 'B1B', configured: !!b1bKey, run: () => queryB1b(b1bKey, String(mpn)) },
    { vendor: 'Arrow', configured: !!(arrowLogin && arrowKey), run: () => queryArrow(arrowLogin, arrowKey, String(mpn)) },
    { vendor: 'element14', configured: !!e14Key, run: () => queryElement14(e14Key, String(mpn)) },
  ];
  const offers = await Promise.all(jobs.map(async (jb) => {
    if (!jb.configured) return { vendor: jb.vendor, configured: false, found: false };
    try {
      const out = await jb.run();
      return { vendor: jb.vendor, configured: true, ...out };
    } catch (e) {
      return { vendor: jb.vendor, configured: true, found: false, error: String(e.message ?? e).slice(0, 120) };
    }
  }));
  res.setHeader('Cache-Control', 'public, max-age=600');
  return res.status(200).send(JSON.stringify({ offers }));
  } finally {
    lease.release();
  }
}

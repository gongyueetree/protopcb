/**
 * api/suppliers.js — 供应商价格/库存聚合代理（Mouser / Arrow / element14）
 *
 * Vercel 环境变量（服务端专用，不带 VITE_ 前缀）：
 *   MOUSER_API_KEY                      — Mouser Search API
 *   ARROW_LOGIN + ARROW_API_KEY         — Arrow ItemService（两个都要）
 *   ELEMENT14_API_KEY                   — element14/Farnell Product Search
 *   CECPORT_API_KEY                     — 中电港（国产渠道，预留：配置后自动启用）
 *   B1B_API_KEY                         — 百芯（国产渠道，预留：配置后自动启用）
 *
 * GET /api/suppliers?path=status → { mouser, arrow, element14 }（各自是否已配置）
 * GET /api/suppliers?mpn=XXX     → { offers: [{vendor, configured, found, price, currency, stock, url}] }
 *
 * 注意：Arrow/element14 的响应映射按公开文档编写，属防御式实现；
 * 你申请到 Key 后首次调用如字段有偏差，只需校准本文件对应的 mapXxx 函数。
 */

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : undefined; };

/* ---------- 国产渠道预留骨架（中电港 / 百芯）----------
 * 两家均需商务开通后获得 API 文档；以下按常见 REST 形态编写，
 * 拿到真实文档后只需校准 URL、鉴权头和响应字段映射。 */
async function queryCecport(key, mpn) {
  // TODO(接入时校准)：中电港 API 端点与鉴权方式
  const r = await fetch(`https://api.cecport.com/v1/product/search?keyword=${encodeURIComponent(mpn)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`cecport ${r.status}`);
  const j = await r.json();
  const p = (j?.data?.list ?? j?.results ?? [])[0];
  if (!p) return { found: false };
  return { found: true, price: num(p.price ?? p.unitPrice), currency: p.currency ?? 'CNY', stock: num(p.stock ?? p.quantity), url: p.url };
}
async function queryB1b(key, mpn) {
  // TODO(接入时校准)：百芯 API 端点与鉴权方式
  const r = await fetch(`https://api.b1b.com/open/search?q=${encodeURIComponent(mpn)}`, {
    headers: { 'X-API-KEY': key },
  });
  if (!r.ok) throw new Error(`b1b ${r.status}`);
  const j = await r.json();
  const p = (j?.data ?? j?.items ?? [])[0];
  if (!p) return { found: false };
  return { found: true, price: num(p.price), currency: 'CNY', stock: num(p.stock), url: p.url };
}

/* ---------- Mouser ---------- */
async function queryMouser(key, mpn) {
  const r = await fetch(`https://api.mouser.com/api/v1/search/keyword?apiKey=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ SearchByKeywordRequest: { keyword: mpn, records: 3, startingRecord: 0 } }),
  });
  if (!r.ok) throw new Error(`mouser ${r.status}`);
  const j = await r.json();
  const parts = j?.SearchResults?.Parts ?? [];
  const exact = parts.find((p) => String(p?.ManufacturerPartNumber ?? '').toUpperCase() === mpn.toUpperCase()) ?? parts[0];
  if (!exact) return { found: false };
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
  const r = await fetch(`https://api.arrow.com/itemservice/v4/en/search/token?login=${encodeURIComponent(login)}&apikey=${encodeURIComponent(key)}&search_token=${encodeURIComponent(mpn)}&rows=3`);
  if (!r.ok) throw new Error(`arrow ${r.status}`);
  const j = await r.json();
  const parts = j?.itemserviceresult?.data?.[0]?.PartList ?? [];
  const part = parts[0];
  if (!part) return { found: false };
  const src = (part.InvOrg?.webSites ?? []).flatMap((w) => w?.sources ?? []);
  const pd = src.flatMap((sc) => sc?.sourceParts ?? [])[0];
  const price = pd?.Prices?.resaleList?.[0]?.price ?? pd?.prices?.[0]?.price;
  const stock = pd?.Availability?.[0]?.fohQuantity;
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
  const r = await fetch(url);
  if (!r.ok) throw new Error(`element14 ${r.status}`);
  const j = await r.json();
  const products = j?.manufacturerPartNumberSearchReturn?.products ?? j?.keywordSearchReturn?.products ?? [];
  const p = products[0];
  if (!p) return { found: false };
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
  const { path, mpn } = req.query ?? {};
  const t = (v) => (v ?? '').trim() || undefined;
  const mouserKey = t(process.env.MOUSER_API_KEY);
  const arrowLogin = t(process.env.ARROW_LOGIN);
  const arrowKey = t(process.env.ARROW_API_KEY);
  const e14Key = t(process.env.ELEMENT14_API_KEY);
  const cecKey = t(process.env.CECPORT_API_KEY);
  const b1bKey = t(process.env.B1B_API_KEY);

  if (path === 'status') {
    return res.status(200).send(JSON.stringify({ mouser: !!mouserKey, arrow: !!(arrowLogin && arrowKey), element14: !!e14Key, cecport: !!cecKey, b1b: !!b1bKey }));
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
        const r = await fetch(`https://api.mouser.com/api/v1/search/keyword?apiKey=${encodeURIComponent(mouserKey)}`, {
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
            });
          }
        } else notes.push(`Mouser ${r.status}`);
      } catch (e) { notes.push(`Mouser ${String(e.message ?? e).slice(0, 60)}`); }
    }

    // DigiKey 关键词检索（复用 /api/digikey 的令牌逻辑；未配置则跳过）
    const dkId = t(process.env.DIGIKEY_CLIENT_ID), dkSecret = t(process.env.DIGIKEY_CLIENT_SECRET);
    if (dkId && dkSecret && items.length < limit) {
      try {
        const tk = await fetch('https://api.digikey.com/v1/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `client_id=${encodeURIComponent(dkId)}&client_secret=${encodeURIComponent(dkSecret)}&grant_type=client_credentials`,
        });
        if (tk.ok) {
          const { access_token } = await tk.json();
          const r = await fetch('https://api.digikey.com/products/v4/search/keyword', {
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

  if (!mpn) return res.status(400).send(JSON.stringify({ error: 'usage: ?mpn=XXX' }));

  const jobs = [
    { vendor: 'Mouser', configured: !!mouserKey, run: () => queryMouser(mouserKey, String(mpn)) },
    // 国产渠道（预留骨架）：配置 Key 后按各家真实响应字段校准 map 函数即可启用
    { vendor: 'CECPort', configured: !!cecKey, run: () => queryCecport(cecKey, String(mpn)) },
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
}

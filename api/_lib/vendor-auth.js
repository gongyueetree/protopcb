/**
 * api/_lib/vendor-auth.js —— 国产供应商接口认证算法（纯函数，可离线单测）
 *
 * 两套算法分别严格按对接文档实现：
 *
 * 【Iceasy】（iceasy-api-integration.md, 2026-09-11）
 *   date       = yyyyMMddHHmmss（进程本地时间，24h，秒精度）
 *   aesKeyText = UPPERCASE(MD5(account + date) 十六进制前 16 字符)   ← 文本字节作密钥
 *   key        = Base64(AES-128-ECB-PKCS7(password))
 *   表单 POST：partNoList / account / date / key（每次单料号）
 *   文档自带固定校验样例，见 __tests__/vendor-auth.test.js
 *
 * 【OURIC】（OURIC_API对接文档 v1.0, 2026-04-13）
 *   收集除 signature 外全部参数（null 不参与）→ 按 key 字母序 k=v&k=v 拼接
 *   signature = Hex(HMAC-MD5(apiSecret, 拼接串))，32 位小写十六进制
 *   JSON POST：认证参数 + 业务条件；timestamp 秒级，服务端允许 ±300s
 *
 * 凭据只在服务端使用（环境变量不带 VITE_ 前缀），绝不进前端 bundle 或日志。
 */
import crypto from 'node:crypto';

/* ---------------- Iceasy ---------------- */

/**
 * 生成 Iceasy 认证参数 { date, key }。now 可注入以便测试固定样例。
 *
 * ⚠ 时区：Iceasy 按**中国时间**校验（接口负责人确认）。文档里的参考实现读的是
 * 进程本地时间，但我们部署在 Vercel，进程 TZ 是 UTC —— 直接用本地时间会差 8 小时，
 * 必然鉴权失败。因此这里显式按 Asia/Shanghai 取年月日时分秒。
 */
export function buildIceasyAuth(account, password, now = new Date()) {
  const pad = (v) => String(v).padStart(2, '0');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  const hour = parts.hour === '24' ? '00' : parts.hour;   // 某些运行时 hour12:false 会把 0 点给成 24
  const date = `${parts.year}${parts.month}${parts.day}${hour}${pad(parts.minute)}${pad(parts.second)}`;

  // MD5(account+date) 十六进制前 16 字符转大写，作为 UTF-8 文本字节的 AES-128 密钥
  const aesKeyText = crypto.createHash('md5')
    .update(account + date, 'utf8')
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();

  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(aesKeyText, 'utf8'), null);
  cipher.setAutoPadding(true);   // PKCS#7
  const key = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]).toString('base64');

  return { date, key };
}

/**
 * Iceasy data.rows → 统一 offer 映射（纯函数）。
 * 文档第 6 节：只取与请求 MPN 精确匹配（区分大小写）的记录；
 * rows 缺失/类型错误由调用方在解析层拒绝，这里只处理合法数组。
 * prices 为空 = 无可用报价，不虚构零元价。
 */
export function mapIceasyRows(rows, partNo) {
  const matched = (Array.isArray(rows) ? rows : []).filter((r) => r?.partNo === partNo);
  if (!matched.length) return { found: false, note: 'no exact match' };
  const row = matched[0];
  const ladder = Array.isArray(row.prices) ? row.prices.filter((p) => Number.isFinite(p?.price) && Number.isFinite(p?.qty)) : [];
  ladder.sort((a, b) => a.qty - b.qty);
  const first = ladder[0];
  return {
    found: true,
    price: first ? first.price : undefined,        // 最低数量档；无阶梯则无价格
    currency: 'CNY',                                // 参考集成按人民币展示（文档第 5 节）
    stock: Number.isFinite(row.stockNumCn) ? row.stockNumCn : undefined,
    url: typeof row.url === 'string' ? row.url : undefined,
    priceBreaks: ladder.map((p) => ({ qty: p.qty, price: p.price })),
  };
}

/* ---------------- OURIC ---------------- */

/**
 * OURIC 签名：除 signature 外全部参数，值为 null/undefined 不参与，
 * 按 key 字母序拼 k=v&k=v，再 Hex(HMAC-MD5(secret, 串))。
 */
export function buildOuricSignature(secret, params) {
  const toSign = Object.entries(params)
    .filter(([k, v]) => k !== 'signature' && v !== null && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = crypto.createHmac('md5', String(secret)).update(toSign, 'utf8').digest('hex');
  return { toSign, signature };
}

/** 组装 OURIC /openapi/products 请求体（含签名）。now 秒级时间戳可注入测试。 */
export function buildOuricRequestBody(apiKey, apiSecret, business = {}, nowSec = Math.floor(Date.now() / 1000)) {
  const params = { apiKey, timestamp: nowSec, ...business };
  const { signature } = buildOuricSignature(apiSecret, params);
  return { ...params, signature };
}

/**
 * OURIC data 商品数组 → 统一 offer（纯函数）。
 * showPrice 是 JSON 字符串形式的阶梯价 [{price:"2.379",number:"1"},…]（文档 4.5 示例）；
 * 解析失败按无报价处理，不猜测。partNumber 精确匹配（不区分大小写，与站内其它渠道口径一致）。
 * 币种/含税口径文档未明确 → 不标 currency，note 提示待确认。
 */
export function mapOuricData(data, partNumber) {
  const list = Array.isArray(data) ? data : [];
  const matched = list.filter((r) => String(r?.partNumber ?? '').toUpperCase() === String(partNumber).toUpperCase());
  if (!matched.length) return { found: false, note: 'no exact match' };
  const row = matched[0];
  let ladder = [];
  if (typeof row.showPrice === 'string' && row.showPrice.trim()) {
    try {
      const arr = JSON.parse(row.showPrice);
      if (Array.isArray(arr)) {
        ladder = arr
          .map((p) => ({ qty: parseInt(String(p?.number ?? ''), 10), price: parseFloat(String(p?.price ?? '')) }))
          .filter((p) => Number.isFinite(p.qty) && Number.isFinite(p.price))
          .sort((a, b) => a.qty - b.qty);
      }
    } catch { /* showPrice 非法 JSON → 视为无阶梯报价 */ }
  }
  const stock = Number.isFinite(row.availableQuantity) ? row.availableQuantity
    : Number.isFinite(row.quantity) ? row.quantity : undefined;
  return {
    found: true,
    price: ladder[0]?.price,
    currency: 'USD',                                 // 已与 OURIC 确认为美元计价
    stock,
    url: undefined,                                  // 文档未提供商品页链接字段
    priceBreaks: ladder,
    // 含税口径仍未确认，只在有额外信息时给 note
    note: [row.vrFlag === 1 ? '虚拟库存' : '', row.moq ? `MOQ ${row.moq}` : ''].filter(Boolean).join(' · ') || undefined,
    warehouse: typeof row.warehouse === 'string' ? row.warehouse : undefined,
    deliveryTime: typeof row.deliveryTime === 'string' ? row.deliveryTime : undefined,
  };
}

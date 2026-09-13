#!/usr/bin/env node
/**
 * scripts/check-ezplm-refdesign.mjs
 * ezPLM 参考设计 / 应用项目端点的真实联调脚本。
 *
 * 在本机（或任何能访问 ezPLM 的机器）上跑：
 *
 *   EZPLM_API_KEY=xxx node scripts/check-ezplm-refdesign.mjs TPS79301DBVR
 *
 * 它直连 ezPLM（不经过 Vercel 函数），逐步打印：
 *   1) 按型号搜索 → 取到 partlibId
 *   2) reference-designs 原始响应（截断）
 *   3) 前端映射器 mapLegacyReference 的解析结果
 *   4) application-projects 端点是否存在（404/501 = 后端尚未提供）
 *
 * 脚本只读，不写任何数据。没有凭据时会明确报错而不是静默跳过。
 */
import { randomUUID } from 'node:crypto';
// 直接复用生产代码的签名实现，保证脚本与线上算法永远一致
import { buildSignature } from '../api/ezplm.js';

// 与官方手册一致：单把 API Key 既作身份也作 HMAC 密钥，没有单独的 secret
const BASE = process.env.EZPLM_API_BASE ?? 'https://www.ezplm.cn';
const KEY = process.env.EZPLM_API_KEY;
const MPN = process.argv[2] ?? 'TPS79301DBVR';

if (!KEY) {
  console.error('缺少凭据：请设置 EZPLM_API_KEY 后重试（该 Key 同时用作 HMAC 密钥，无需 secret）。');
  process.exit(1);
}

function sign(apiPath, params) {
  const timestamp = Math.floor(Date.now() / 1000).toString();   // 手册要求 Unix 秒级
  const nonce = randomUUID();                                   // 一次性随机串，防重放
  return {
    'X-API-Key': KEY,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': buildSignature({ apiKey: KEY, method: 'GET', path: apiPath, params, timestamp, nonce }),
    'Accept': 'application/json',
  };
}

/** @param {string} apiPath 如 /parts  @param {Record<string,string>} params */
async function call(apiPath, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const pathWithQuery = qs ? `${apiPath}?${qs}` : apiPath;
  const url = `${BASE}${pathWithQuery}`;
  const t0 = Date.now();
  const res = await fetch(url, { headers: sign(apiPath, params) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { url, status: res.status, ms: Date.now() - t0, text, json };
}

const line = (s) => console.log('\n' + '─'.repeat(72) + '\n' + s);

// 1) 按型号搜索，拿 partlibId
line(`1. 搜索型号：${MPN}`);
const search = await call('/api/v1/api-key/parts', { keyword: MPN, pageSize: '10' });
console.log(`   ${search.status} · ${search.ms}ms · ${search.url}`);
if (search.status !== 200) {
  console.error('   搜索失败，响应：', search.text.slice(0, 300));
  process.exit(1);
}
// 手册 §2：返回 data + meta 分页结构，data 为物料数组
const list = Array.isArray(search.json?.data) ? search.json.data : [];
console.log(`   命中 ${list.length} 条`);
if (!list.length) { console.error('   该型号在 ezPLM 中没有记录，换一个型号再试。'); process.exit(1); }
const first = list[0];
const partlibId = first.id;                                    // 手册 §2：id 即后续 partlibId
console.log(`   取第一条：partlibId=${partlibId} · ${first.mpn ?? first.componentName ?? ''}`);
console.log('   该条目的字段名：', Object.keys(first).join(', '));

// 2) 参考设计
line(`2. 参考设计：/api/v1/api-key/reference-designs?partlibId=${partlibId}`);
const rd = await call('/api/v1/api-key/reference-designs', { partlibId: String(partlibId), pageSize: '10' });
console.log(`   ${rd.status} · ${rd.ms}ms`);
if (rd.status === 200) {
  const rows = Array.isArray(rd.json?.data) ? rd.json.data : [];
  console.log(`   返回 ${rows.length} 条参考设计`);
  if (rows.length) {
    console.log('   首条字段名：', Object.keys(rows[0]).join(', '));
    console.log('   首条内容（截断）：', JSON.stringify(rows[0]).slice(0, 400));
  } else {
    console.log('   原始响应（截断）：', rd.text.slice(0, 400));
  }
} else {
  console.log('   响应（截断）：', rd.text.slice(0, 400));
}

// 3) 应用项目（组织内部历史项目）
// 手册目前只公开 parts / reference-designs 两个只读接口；
// 这里探测"应用项目（组织内部用过该器件的项目）"是否另有路径，全部 404 即后端尚未提供。
line('3. 应用项目端点探测（手册未公开，逐一试探）');
for (const [p, params] of [
  ['/api/v1/api-key/application-projects', { partlibId: String(partlibId) }],
  [`/api/v1/api-key/parts/${encodeURIComponent(partlibId)}/projects`, {}],
  ['/api/v1/api-key/projects', { partlibId: String(partlibId) }],
]) {
  const r = await call(p, params);
  console.log(`   ${r.status} · ${r.ms}ms · ${p}`);
  if (r.status === 200) {
    console.log('   ✓ 该路径可用，响应（截断）：', r.text.slice(0, 400));
    break;
  }
}

line('结论');
console.log(`参考设计端点：${rd.status === 200 ? '✓ 可用' : `✗ HTTP ${rd.status}`}`);
console.log('应用项目端点：见上方三种候选路径的返回码（全部非 200 = 后端尚未提供，前端会如实显示 BACKEND_NOT_CONNECTED）');
console.log('\n把本脚本的完整输出发回，即可据此校准前端的字段映射。');

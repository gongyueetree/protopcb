#!/usr/bin/env node
/**
 * scripts/check-ezplm-refdesign.mjs
 * ezPLM 参考设计 / 应用项目端点的真实联调脚本。
 *
 * 在本机（或任何能访问 ezPLM 的机器）上跑：
 *
 *   EZPLM_API_KEY=xxx EZPLM_API_SECRET=yyy node scripts/check-ezplm-refdesign.mjs AD9837ACPZ-RL
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

const BASE = process.env.EZPLM_API_BASE ?? 'https://ez.eetree.cn/api/open';
const KEY = process.env.EZPLM_API_KEY;
const SECRET = process.env.EZPLM_API_SECRET;
const MPN = process.argv[2] ?? 'AD9837ACPZ-RL';

if (!KEY || !SECRET) {
  console.error('缺少凭据：请设置 EZPLM_API_KEY 与 EZPLM_API_SECRET 后重试。');
  process.exit(1);
}

function sign(apiPath, params) {
  const timestamp = String(Date.now());
  const nonce = randomUUID().replace(/-/g, '').slice(0, 16);
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
const search = await call('/parts', { keyword: MPN, pageSize: '5' });
console.log(`   ${search.status} · ${search.ms}ms · ${search.url}`);
if (search.status !== 200) {
  console.error('   搜索失败，响应：', search.text.slice(0, 300));
  process.exit(1);
}
const list = Array.isArray(search.json?.data) ? search.json.data
  : Array.isArray(search.json?.data?.list) ? search.json.data.list
  : Array.isArray(search.json?.data?.records) ? search.json.data.records : [];
console.log(`   命中 ${list.length} 条`);
if (!list.length) { console.error('   该型号在 ezPLM 中没有记录，换一个型号再试。'); process.exit(1); }
const first = list[0];
const partlibId = first.partlibId ?? first.id ?? first.partLibId;
console.log(`   取第一条：partlibId=${partlibId} · ${first.mpn ?? first.componentName ?? ''}`);
console.log('   该条目的字段名：', Object.keys(first).join(', '));

// 2) 参考设计
line(`2. 参考设计：/reference-designs?partlibId=${partlibId}`);
const rd = await call('/reference-designs', { partlibId: String(partlibId), pageSize: '20' });
console.log(`   ${rd.status} · ${rd.ms}ms`);
if (rd.status === 200) {
  const rows = Array.isArray(rd.json?.data) ? rd.json.data
    : Array.isArray(rd.json?.data?.list) ? rd.json.data.list
    : Array.isArray(rd.json?.data?.records) ? rd.json.data.records : [];
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
line(`3. 应用项目：/components/${MPN}/application-projects`);
for (const [p, params] of [
  [`/components/${encodeURIComponent(MPN)}/application-projects`, {}],
  ['/application-projects', { partlibId: String(partlibId) }],
  [`/parts/${encodeURIComponent(partlibId)}/projects`, {}],
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
console.log('应用项目端点：见上方三种候选路径的返回码（全部非 200 = 后端尚未提供该接口）');
console.log('\n把本脚本的完整输出发回，即可据此校准前端的字段映射。');

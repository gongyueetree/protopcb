/**
 * api/gemini.js — 仅保留 GET status / diag 的薄适配器。
 *
 * 旧的 POST { prompt, capability } 接口已整体下线（410）：浏览器决定 capability 是计费漏洞。
 * 业务 AI 调用一律走 POST /api/ai（服务端拼 prompt、固定计费）。
 * Gemini 的真实调用在 api/_lib/ai/gemini-executor.js。
 */
import crypto from 'node:crypto';
import { acquire, deny } from './_lib/guard.js';
import { callGemini } from './_lib/ai/gemini-executor.js';

export { callGemini };   // 兼容既有导入（/api/ai）

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST') {
    return res.status(410).send(JSON.stringify({ error: 'POST /api/gemini 已下线，请使用 POST /api/ai { operation, operationId, input }', code: 'ENDPOINT_RETIRED' }));
  }
  const apiKey = (process.env.GEMINI_API_KEY ?? '').trim();
  const path = String(req.query?.path ?? 'status');

  if (path === 'status') {
    return res.status(200).send(JSON.stringify({ configured: !!apiKey }));
  }

  if (path === 'diag') {
    // 管理员诊断：需 ADMIN_DIAG_TOKEN（>=16 字符），且仍受限流
    const lease = acquire(req, 'gemini-diag');
    if (!lease.ok) return deny(res, lease);
    try {
      const want = (process.env.ADMIN_DIAG_TOKEN ?? '').trim();
      const got = String(req.headers['x-admin-token'] ?? '');
      const okTok = want.length >= 16 && got.length === want.length
        && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
      if (!okTok) return res.status(403).send(JSON.stringify({ error: 'diag requires x-admin-token' }));
      if (!apiKey) return res.status(501).send(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
      const out = await callGemini(apiKey, 'reply with the single word: ok', 0);
      return res.status(200).send(JSON.stringify({ ok: true, model: out.model, sample: String(out.text).slice(0, 40) }));
    } catch (e) {
      return res.status(502).send(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 200) }));
    } finally {
      lease.release();
    }
  }
  return res.status(400).send(JSON.stringify({ error: 'usage: GET ?path=status | diag' }));
}

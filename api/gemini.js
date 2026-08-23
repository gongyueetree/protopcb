import { acquire, checkBodySize, checkAiPayload, deny, LIMITS, readJsonBody } from './_lib/guard.js';
import { safeFetch } from './_lib/safe-fetch.js';
import { fetchUpstream, UpstreamError } from './_lib/net.js';

/**
 * api/gemini.js — Vercel Serverless Function：Gemini 代理
 * Key 存服务端环境变量 GEMINI_API_KEY（不带 VITE_ 前缀，不进前端 bundle）。
 *
 * GET  /api/gemini?path=status   → { configured }
 * POST /api/gemini  body {prompt} → { text }
 */
// 模型候选：不同 Key 可用模型不同，按序尝试并缓存可用者；GEMINI_MODEL 环境变量可强制指定
const MODEL_CANDIDATES = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];
let workingModel = null;

function modelUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

async function callGemini(apiKey, prompt, temperature = 0.35, inline = null) {
  // GEMINI_MODEL 指定的模型排最前，但失败后仍自动降级到候选列表（配置笔误不至于全盘失效）
  const forced = (process.env.GEMINI_MODEL ?? '').trim();
  const base = workingModel ? [workingModel, ...MODEL_CANDIDATES.filter((m) => m !== workingModel)] : MODEL_CANDIDATES;
  const candidates = forced ? [forced, ...base.filter((m) => m !== forced)] : base;
  let lastErr = 'no model tried';
  for (const model of candidates) {
    // gemini-2.5 系默认开启"思考"，会吃光输出 token 导致正文为空 → 显式关闭思考预算
    const generationConfig = { temperature, maxOutputTokens: 8192 };
    if (model.startsWith('gemini-2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    let r, j;
    try {
      // 统一出站通道：AbortController 超时 + 流式响应上限（Gemini 正常响应远小于该值）
      const out = await fetchUpstream(`${modelUrl(model)}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: inline ? [{ inline_data: inline }, { text: prompt }] : [{ text: prompt }] }], generationConfig }),
        timeoutMs: LIMITS.timeoutMs,
        maxResponseBytes: 8 * 1024 * 1024,
        as: 'json',
      });
      r = out.res; j = out.json;
    } catch (e) {
      if (e instanceof UpstreamError && e.kind === 'timeout') { lastErr = `${model}: 上游超时`; break; }
      lastErr = `${model}: ${e instanceof UpstreamError ? `${e.message} ${e.detail}` : String(e?.message ?? e)}`.slice(0, 200);
      continue;
    }
    if (r.ok) {
      const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (text.trim()) {
        workingModel = model;
        return { model, text };
      }
      // 正文为空（思考吃光预算/安全拦截等）→ 视为失败换下一个模型
      lastErr = `${model}: 返回正文为空 (finishReason=${j?.candidates?.[0]?.finishReason ?? '未知'})`;
      continue;
    }
    lastErr = `${model}: HTTP ${r.status} ${JSON.stringify(j?.error?.message ?? '').slice(0, 180)}`;
    if (r.status !== 404 && r.status !== 400) break; // 非模型不存在类错误（如 401/429）不再换模型
  }
  throw new Error(lastErr);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const apiKey = (process.env.GEMINI_API_KEY ?? '').trim() || undefined;

  if (req.method === 'GET') {
    const path = req.query?.path ?? '';
    if (path === 'status') {
      return res.status(200).send(JSON.stringify({ configured: !!apiKey }));
    }
    // 诊断：会真实调用一次付费上游 → 绝不能匿名开放。
    // 旧实现任何人 GET ?path=diag 即可反复触发 Gemini 计费调用（在 acquire 之前）。
    // 现在：production 默认禁用；仅在设置了服务端 ADMIN_DIAG_TOKEN（非 VITE_，
    // 不进前端 bundle）且请求头携带匹配 token 时可用；且必须先过限流。
    if (path === 'diag') {
      const adminToken = (process.env.ADMIN_DIAG_TOKEN ?? '').trim();
      const provided = String(req.headers['x-admin-token'] ?? '').trim();
      const tokenOk = adminToken.length >= 16 && provided.length === adminToken.length
        && (await import('node:crypto')).timingSafeEqual(Buffer.from(provided), Buffer.from(adminToken));
      if (!tokenOk) {
        return res.status(process.env.NODE_ENV === 'production' ? 404 : 403)
          .send(JSON.stringify({ error: 'diag 已禁用：需服务端 ADMIN_DIAG_TOKEN（≥16字符）并携带 x-admin-token 头' }));
      }
      const diagLease = acquire(req, 'gemini');       // 即使持有 token 也过限流
      if (!diagLease.ok) return deny(res, diagLease);
      try {
        if (!apiKey) return res.status(200).send(JSON.stringify({ ok: false, error: 'GEMINI_API_KEY 未配置' }));
        const out = await callGemini(apiKey, '只回复两个字：正常', 0);
        return res.status(200).send(JSON.stringify({ ok: true, model: out.model, reply: out.text.slice(0, 40) }));
      } catch (e) {
        return res.status(200).send(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
      } finally {
        diagLease.release();
      }
    }
    return res.status(400).send(JSON.stringify({ error: 'POST {prompt} or GET ?path=status|diag' }));
  }
  if (!apiKey) {
    return res.status(501).send(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
  }

  // ── 配额防护：体积 → 频率/并发 → AI 入参 ──
  const sizeCheck = checkBodySize(req);
  if (!sizeCheck.ok) return deny(res, sizeCheck);
  const lease = acquire(req, 'gemini');
  if (!lease.ok) return deny(res, lease);

  try {
    const body = readJsonBody(req);
    const aiCheck = checkAiPayload(body);
    if (!aiCheck.ok) return deny(res, aiCheck);
    let prompt = String(body.prompt ?? '');
    if (!prompt) return res.status(400).send(JSON.stringify({ error: 'prompt required' }));
    // PDF 上传直读：不经 ds2kicad 时的兜底提取链路
    if (body.pdfBase64) {
      const out = await callGemini(apiKey, prompt, Number(body.temperature ?? 0.2), { mime_type: 'application/pdf', data: String(body.pdfBase64) });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(JSON.stringify({ text: out.text, model: out.model }));
    }
    // 图片模式：datasheet 截图/引脚图直接喂视觉模型
    if (body.imageBase64) {
      const mime = String(body.imageMime ?? 'image/png');
      const out = await callGemini(apiKey, prompt, Number(body.temperature ?? 0.2), { mime_type: mime, data: String(body.imageBase64) });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(JSON.stringify({ text: out.text, model: out.model }));
    }
    // URL 模式：PDF 链接下载字节直喂模型（inline_data）；网页链接抓正文文本
    let urlInline = null;
    if (body.url) {
      try {
        // safeFetch：协议白名单 + DNS 解析后 IP 判定 + 逐跳重定向校验 + 大小/超时限制
        const { buffer, contentType } = await safeFetch(String(body.url), {
          allowHttp: process.env.ALLOW_HTTP_FETCH === '1',
          maxBytes: LIMITS.fileBytes,
          timeoutMs: 20000,
        });
        const isPdf = /pdf/i.test(contentType) || buffer.slice(0, 5).toString() === '%PDF-';
        if (isPdf) {
          if (buffer.slice(0, 5).toString() !== '%PDF-') {
            return res.status(422).send(JSON.stringify({ error: '链接内容不是有效的 PDF' }));
          }
          urlInline = { mime_type: 'application/pdf', data: buffer.toString('base64') };
        } else if (/^text\/|application\/(xhtml|json)/i.test(contentType)) {
          prompt = `以下是网页 ${body.url} 的正文内容：\n${buf2text(buffer.toString('utf8'))}\n\n${prompt}`;
        } else {
          return res.status(415).send(JSON.stringify({ error: `不支持的链接内容类型：${contentType.split(';')[0] || '未知'}` }));
        }
      } catch (e) {
        return res.status(400).send(JSON.stringify({ error: 'URL 抓取失败: ' + String(e.message ?? e).slice(0, 160) }));
      }
    }
    function buf2text(html) {
      return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 80000);
    }

    const inline = body.fileBase64 ? { mime_type: String(body.mimeType ?? 'application/pdf'), data: String(body.fileBase64) } : urlInline;
    const out = await callGemini(apiKey, prompt, 0.35, inline);
    return res.status(200).send(JSON.stringify({ text: out.text, model: out.model }));
  } catch (err) {
    return res.status(502).send(JSON.stringify({ error: 'gemini request failed', detail: String(err).slice(0, 300) }));
  } finally {
    lease.release();
  }
}

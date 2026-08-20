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
    const r = await fetch(`${modelUrl(model)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: inline ? [{ inline_data: inline }, { text: prompt }] : [{ text: prompt }] }], generationConfig }),
    });
    if (r.ok) {
      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (text.trim()) {
        workingModel = model;
        return { model, text };
      }
      // 正文为空（思考吃光预算/安全拦截等）→ 视为失败换下一个模型
      lastErr = `${model}: 返回正文为空 (finishReason=${j?.candidates?.[0]?.finishReason ?? '未知'})`;
      continue;
    }
    lastErr = `${model}: HTTP ${r.status} ${(await r.text()).slice(0, 180)}`;
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
    // 诊断：真实调用一次上游，返回可用模型或具体错误（浏览器直接打开可见）
    if (path === 'diag') {
      if (!apiKey) return res.status(200).send(JSON.stringify({ ok: false, error: 'GEMINI_API_KEY 未配置' }));
      try {
        const out = await callGemini(apiKey, '只回复两个字：正常', 0);
        return res.status(200).send(JSON.stringify({ ok: true, model: out.model, reply: out.text.slice(0, 40) }));
      } catch (e) {
        return res.status(200).send(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
      }
    }
    return res.status(400).send(JSON.stringify({ error: 'POST {prompt} or GET ?path=status|diag' }));
  }
  if (!apiKey) {
    return res.status(501).send(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
    let prompt = String(body.prompt ?? '');
    if (!prompt) return res.status(400).send(JSON.stringify({ error: 'prompt required' }));
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
        const page = await fetch(String(body.url), { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const ct = page.headers.get('content-type') ?? '';
        const isPdf = /pdf/i.test(ct) || /\.pdf(\?|#|$)/i.test(String(body.url));
        if (isPdf) {
          const buf = Buffer.from(await page.arrayBuffer());
          if (buf.length > 4 * 1024 * 1024) return res.status(413).send(JSON.stringify({ error: 'PDF 超过 4MB，请下载后裁剪关键页再上传' }));
          if (buf.slice(0, 5).toString() !== '%PDF-') return res.status(422).send(JSON.stringify({ error: '链接内容不是 PDF' }));
          urlInline = { mime_type: 'application/pdf', data: buf.toString('base64') };
        } else {
          const html = buf2text(await page.text());
          prompt = `以下是网页 ${body.url} 的正文内容：\n${html}\n\n${prompt}`;
        }
      } catch (e) {
        return res.status(400).send(JSON.stringify({ error: 'URL 抓取失败: ' + String(e).slice(0, 120) }));
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
  }
}

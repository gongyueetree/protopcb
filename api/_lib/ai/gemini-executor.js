/**
 * api/_lib/ai/gemini-executor.js
 * Gemini 调用的**唯一**执行器。只做一件事：拿 prompt（+可选内联附件）→ 上游 → 文本。
 * 不做鉴权、不做扣费、不拼业务 prompt —— 那些在 /api/ai 与 AI_OPERATIONS 里。
 */
import { fetchUpstream, UpstreamError } from '../net.js';
import { LIMITS } from '../guard.js';

/** 候选模型按优先级排列；某个模型 404/限流时自动降级到下一个 */
const MODEL_CANDIDATES = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];
/** 上次成功的模型（进程内记忆，冷启动后重新探测） */
let workingModel = null;

function modelUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export async function callGemini(apiKey, prompt, temperature = 0.35, inline = null) {
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


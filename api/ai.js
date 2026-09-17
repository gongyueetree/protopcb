/**
 * api/ai.js
 * AI 调用的**唯一**入口。浏览器只发 { operation, operationId, input }，不发 prompt。
 *
 * 流程（顺序不可调换）：
 *   查表（未知 → 400，零扣费零模型调用）
 *   → 校验 input（不符 → 400）
 *   → 会话（未登录 → 401）
 *   → 扣费（operationId 幂等；余额不足 → 402）
 *   → 服务端拼 prompt
 *   → 调模型
 *   → 返回 { data, usage: { operation, charged, remaining, operationId } }
 *
 * 旧的 /api/gemini 保留为管理员兼容入口，业务代码不再调用它。
 */
import { acquire, deny, checkBodySize, readJsonBody, checkAiPayload } from './_lib/guard.js';
import { requireAiAccess, verifySession } from './_lib/session.js';
import { lookupOperation } from './_lib/ai-operations.js';
import { callGemini } from './gemini.js';
import { safeFetch } from './_lib/safe-fetch.js';
import { ds2Available, runDs2Extract } from './_lib/ai/part-extract-executor.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).send(JSON.stringify({ error: 'POST only' }));

  const sizeCheck = checkBodySize(req);
  if (!sizeCheck.ok) return deny(res, sizeCheck);
  const lease = acquire(req, 'ai');
  if (!lease.ok) return deny(res, lease);

  try {
    const body = readJsonBody(req);
    const operation = String(body?.operation ?? '');
    const op = lookupOperation(operation);
    // 未知操作：400，且不进入任何扣费/模型路径 —— 这里绝不允许 `?? 1` 之类的兜底价
    if (!op) return res.status(400).send(JSON.stringify({ error: `unknown operation: ${operation || '(empty)'}`, code: 'UNKNOWN_OPERATION' }));

    const operationId = String(body?.operationId ?? '');
    if (!UUID_RE.test(operationId)) return res.status(400).send(JSON.stringify({ error: 'operationId must be a UUID', code: 'BAD_OPERATION_ID' }));

    const input = body?.input ?? {};
    if (!op.validate(input)) return res.status(400).send(JSON.stringify({ error: `invalid input for ${operation}`, code: 'INVALID_INPUT' }));
    if (JSON.stringify(input).length > op.maxInputChars) return res.status(413).send(JSON.stringify({ error: 'input too large', code: 'INPUT_TOO_LARGE' }));

    // 附件：只允许在标注 allowAttachments 的操作上；大小 / MIME / PDF 魔数复用 checkAiPayload
    if (!op.allowAttachments && (body.pdfBase64 || body.imageBase64)) {
      return res.status(400).send(JSON.stringify({ error: 'attachments not allowed for this operation', code: 'INVALID_INPUT' }));
    }
    if (op.allowAttachments) {
      const pc = checkAiPayload(body);
      if (!pc.ok) return res.status(pc.status).send(JSON.stringify({ error: pc.error, code: pc.status === 413 ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_INVALID' }));
      if (op.validateAttachments && !op.validateAttachments(input, body)) {
        return res.status(400).send(JSON.stringify({ error: `${input.mode} 模式必须附带对应附件`, code: 'INVALID_INPUT' }));
      }
    }

    // ── 顺序：校验 → 会话 → 执行器已配置 → 扣费 → 执行 ──
    // 扣费必须在"确认能执行"之后：GEMINI_API_KEY 没配就先扣钱再报 501，用户白白掉 Credit。
    const apiKey = (process.env.GEMINI_API_KEY ?? '').trim();
    const sess = await verifySession(req);
    if (!sess.ok) return res.status(sess.status).send(JSON.stringify({ error: sess.message, code: sess.code, capability: operation }));
    if (!apiKey) return res.status(501).send(JSON.stringify({ error: 'GEMINI_API_KEY not configured', code: 'AI_NOT_CONFIGURED' }));

    // URL 模式：服务端安全抓取（SSRF 防护 / 重定向校验 / 大小与超时上限），
    // 把真实内容交给模型 —— 绝不让模型只凭一个 URL 字符串"猜"页面内容
    let inline = body.pdfBase64 ? { mime_type: 'application/pdf', data: String(body.pdfBase64) }
      : body.imageBase64 ? { mime_type: String(body.imageMime ?? 'image/png'), data: String(body.imageBase64) } : null;
    let effectiveInput = input;
    if (operation === 'part.extract' && input.mode === 'url') {
      let fetched;
      try {
        fetched = await safeFetch(input.url, { maxBytes: 6 * 1024 * 1024, timeoutMs: 15000, allowedContentTypes: [/^application\/pdf/, /^text\/html/, /^text\/plain/] });
      } catch (e) {
        return res.status(422).send(JSON.stringify({ error: `无法抓取该 URL：${String(e?.message ?? e).slice(0, 160)}`, code: 'URL_FETCH_FAILED' }));
      }
      if (/^application\/pdf/.test(fetched.contentType)) {
        inline = { mime_type: 'application/pdf', data: fetched.buffer.toString('base64') };
        effectiveInput = { ...input, mode: 'pdf' };
      } else {
        // HTML/文本：确定性抽正文（去脚本样式标签、压空白），再交模型
        const html = fetched.buffer.toString('utf8');
        const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length < 20) return res.status(422).send(JSON.stringify({ error: '页面没有可提取的文本', code: 'URL_EMPTY' }));
        effectiveInput = { ...input, mode: 'text', text: text.slice(0, 60000) };
      }
    }

    // 扣费（价格来自注册表；operationId 作幂等键）—— 到这里已确认能执行
    const access = await requireAiAccess(req, operation, op.cost, { operationId, session: sess });
    if (!access.ok) return res.status(access.status).send(JSON.stringify(access.body));

    /**
     * part.extract 的 PDF/URL：先试 DS2KiCad（确定性解析，精度高于纯 LLM），失败再回落 Gemini。
     * 两条路径**同一次扣费、同一个 operationId** —— 此前 DS2 走前端直连，成功 0 Credit、
     * 失败才扣 4，同一次提取的价格取决于后台可用性，用户无法预期。
     */
    if (operation === 'part.extract' && (effectiveInput.mode === 'pdf' || effectiveInput.mode === 'url') && ds2Available()) {
      const payload = effectiveInput.mode === 'pdf'
        ? { pdfBase64: inline?.data, fileName: String(body.fileName ?? 'datasheet.pdf') }
        : { url: effectiveInput.url };
      const ds = await runDs2Extract(payload);
      if (ds.ok) {
        return res.status(200).send(JSON.stringify({
          data: { text: JSON.stringify(ds.data), engine: 'ds2kicad' },
          usage: { operation, charged: op.cost, remaining: access.remaining, operationId },
        }));
      }
      // 失败不额外扣费：这一次操作已经收过钱了，继续用 Gemini 完成它
      console.warn('[part.extract] ds2kicad 不可用，回落 Gemini:', ds.reason);
    }

    const prompt = op.buildPrompt(effectiveInput);
    const out = await callGemini(apiKey, prompt, Number(body.temperature ?? 0.2), inline);
    return res.status(200).send(JSON.stringify({
      data: { text: out.text, model: out.model },
      usage: { operation, charged: op.cost, remaining: access.remaining, operationId },
    }));
  } catch (e) {
    return res.status(502).send(JSON.stringify({ error: String(e?.message ?? e).slice(0, 200), code: 'AI_UPSTREAM_ERROR' }));
  } finally {
    lease.release();
  }
}

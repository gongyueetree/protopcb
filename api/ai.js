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
import { acquire, deny, checkBodySize, readJsonBody } from './_lib/guard.js';
import { requireAiAccess } from './_lib/session.js';
import { lookupOperation } from './_lib/ai-operations.js';
import { callGemini } from './gemini.js';

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

    // 附件只允许在标注 allowAttachments 的操作上
    const inline = op.allowAttachments
      ? (body.pdfBase64 ? { mime_type: 'application/pdf', data: String(body.pdfBase64) }
        : body.imageBase64 ? { mime_type: String(body.imageMime ?? 'image/png'), data: String(body.imageBase64) } : null)
      : null;
    if (!op.allowAttachments && (body.pdfBase64 || body.imageBase64)) {
      return res.status(400).send(JSON.stringify({ error: 'attachments not allowed for this operation', code: 'INVALID_INPUT' }));
    }

    // 关卡：会话 + 扣费（价格来自注册表，不来自请求）
    const access = await requireAiAccess(req, operation, op.cost, { operationId });
    if (!access.ok) return res.status(access.status).send(JSON.stringify(access.body));

    const apiKey = (process.env.GEMINI_API_KEY ?? '').trim();
    if (!apiKey) return res.status(501).send(JSON.stringify({ error: 'GEMINI_API_KEY not configured', code: 'AI_NOT_CONFIGURED' }));

    const prompt = op.buildPrompt(input);
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

/**
 * providers/ai-client/index.ts
 * 客户端 AI 调用的**唯一**入口。业务模块不得直接请求 /api/gemini 或 /api/ai。
 *
 * 契约：
 *   aiRequest(operation, input) → { text, usage }
 *   - 浏览器不发 prompt，只发结构化 input；prompt 由服务端按操作拼装
 *   - operationId 为 UUID，服务端账本以 (userId, operationId) 幂等
 *   - 余额**只认**服务端返回的 usage.remaining，前端不再自己扣减
 *   - 401/402/503 翻译成 AiAccessError 向上抛，绝不静默回落 Mock
 */
import { useEntitlementStore } from '../../state/entitlementStore';

export type AiOperation =
  | 'scheme.generate' | 'scheme.revise' | 'subcircuit.recommend' | 'advisor.analyze'
  | 'block.analyze' | 'bom.estimate' | 'part.extract' | 'symbol.generate';

export interface AiUsage { operation: AiOperation; charged: number; remaining: number | null; operationId: string }
export interface AiResult { text: string; model?: string; usage: AiUsage }

export type AiAccessCode = 'LOGIN_REQUIRED' | 'INSUFFICIENT_CREDITS' | 'BACKEND_NOT_CONNECTED' | 'AUTH_UNAVAILABLE' | 'OTHER';

export class AiAccessError extends Error {
  constructor(public code: AiAccessCode, message: string, public cost?: number) {
    super(message);
    this.name = 'AiAccessError';
  }
}

export interface AiAttachments {
  pdfBase64?: string;
  imageBase64?: string;
  imageMime?: string;
}

const newOperationId = (): string =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

function codeOf(status: number, body: { code?: string } | null): AiAccessCode {
  const c = body?.code;
  if (c === 'LOGIN_REQUIRED' || status === 401) return 'LOGIN_REQUIRED';
  if (c === 'INSUFFICIENT_CREDITS' || status === 402) return 'INSUFFICIENT_CREDITS';
  if (c === 'BACKEND_NOT_CONNECTED') return 'BACKEND_NOT_CONNECTED';
  if (c === 'AUTH_UPSTREAM_ERROR' || c === 'CREDIT_UPSTREAM_ERROR' || c === 'AUTH_MISCONFIGURED') return 'AUTH_UNAVAILABLE';
  return 'OTHER';
}

export async function aiRequest(
  operation: AiOperation,
  input: Record<string, unknown>,
  opts: { attachments?: AiAttachments; temperature?: number; operationId?: string } = {},
): Promise<AiResult> {
  const operationId = opts.operationId ?? newOperationId();
  const r = await fetch('/api/ai', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, operationId, input, temperature: opts.temperature, ...(opts.attachments ?? {}) }),
  });

  let body: { data?: { text?: string; model?: string }; usage?: AiUsage; error?: string; code?: string; cost?: number } | null = null;
  try { body = await r.json(); } catch { body = null; }

  if (!r.ok) {
    throw new AiAccessError(codeOf(r.status, body), body?.error ?? `AI 服务 ${r.status}`, body?.cost);
  }
  const usage = body?.usage ?? { operation, charged: 0, remaining: null, operationId };
  // 余额的唯一来源：服务端。这里是全链路里唯一一处 setRemaining。
  if (usage.remaining != null) useEntitlementStore.getState().setRemaining(usage.remaining);
  return { text: String(body?.data?.text ?? ''), model: body?.data?.model, usage };
}

/** 从模型输出中稳健提取 JSON（剥离 ```json 围栏与前后杂文） */
export function extractJson<T>(text: string): T {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const starts = ['{', '['].map((ch) => cleaned.indexOf(ch)).filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start < 0 || end < 0) throw new Error('模型未返回 JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

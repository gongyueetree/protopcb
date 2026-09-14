/**
 * modules/account/useAiGate.tsx
 * AI 门禁的共享入口 —— 所有 AI 调用点用同一套判定与提示。
 *
 * 每个调用点自己写一遍"检查登录 → 检查额度 → 拼提示语"，迟早出现
 * 某处漏检、某处措辞不同、某处把 401 当成"服务异常"。这里统一：
 *   guard(capability, fn)  调用前判定，不通过就展示提示、不发请求；
 *                          请求发出后若服务端仍然拒绝（前端状态过期），
 *                          同样翻译成对应提示，而不是抛一个原始错误。
 */
import { useCallback, useState } from 'react';
import { useEntitlementStore } from '../../state/entitlementStore';
import { AiAccessError } from '../../providers/gemini';
import { AiGateNotice } from './AccountBar';
import type { Capability, DenyReason } from '../../design-core/entitlements';

export interface GateState { reason: DenyReason; cost?: number }

/** 服务端错误码 → 前端提示原因（保持两边语义一致） */
function reasonOf(code: AiAccessError['code']): DenyReason {
  return code === 'LOGIN_REQUIRED' ? 'login-required'
    : code === 'INSUFFICIENT_CREDITS' ? 'insufficient-credits'
      : 'credits-unknown';
}

export function useAiGate() {
  const check = useEntitlementStore((s) => s.check);
  const noteConsumed = useEntitlementStore((s) => s.noteConsumed);
  const [gate, setGate] = useState<GateState | null>(null);

  /**
   * 包住一次 AI 调用。
   * @returns 成功时返回 fn 的结果；被门禁拦下或服务端拒绝时返回 undefined
   *          （调用方据此跳过后续处理，不必自己判断）
   */
  const guard = useCallback(async <T,>(cap: Capability, fn: () => Promise<T>): Promise<T | undefined> => {
    const r = check(cap);
    if (!r.allowed) { setGate({ reason: r.reason!, cost: r.cost }); return undefined; }
    setGate(null);
    try {
      const out = await fn();
      noteConsumed(cap);
      return out;
    } catch (e) {
      // 服务端是权威：前端状态可能过期（比如别处刚把额度用完）
      if (e instanceof AiAccessError) { setGate({ reason: reasonOf(e.code), cost: e.cost ?? r.cost }); return undefined; }
      throw e;
    }
  }, [check, noteConsumed]);

  const gateNotice = gate
    ? <AiGateNotice reason={gate.reason} cost={gate.cost} onClose={() => setGate(null)} />
    : null;

  return { guard, gate, gateNotice, clearGate: () => setGate(null) };
}

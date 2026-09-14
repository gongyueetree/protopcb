/**
 * state/entitlementStore.ts
 * 前端的访问层级与 Credit 状态。
 *
 * 注意定位：这一层只负责**体验**（按钮该不该亮、提示说什么、余额显示多少）。
 * 真正的拦截在服务端（api/_lib/session.js）—— 即使有人改掉这里的状态，
 * AI 接口照样会返回 401/402。
 */
import { create } from 'zustand';
import {
  ANONYMOUS, checkCapability, applyCost, loginUrl, buyCreditsUrl,
  type Entitlements, type Capability, type CapabilityCheck,
} from '../design-core/entitlements';

interface EntitlementState {
  ent: Entitlements;
  status: 'idle' | 'loading' | 'ready';
  refresh: () => Promise<void>;
  check: (cap: Capability) => CapabilityCheck;
  /** 调用成功后乐观扣减本地余额；服务端返回的余额会在下次 refresh 覆盖它 */
  noteConsumed: (cap: Capability) => void;
  /** 服务端通过响应头回传的权威余额 */
  setRemaining: (remaining: number) => void;
}

export const useEntitlementStore = create<EntitlementState>((set, get) => ({
  ent: ANONYMOUS,
  status: 'idle',

  refresh: async () => {
    set({ status: 'loading' });
    try {
      // 带 Cookie 请求：会话由 ezPLM / EEHub 签发，我们只读
      const r = await fetch('/api/session', { credentials: 'include' });
      if (!r.ok) { set({ ent: ANONYMOUS, status: 'ready' }); return; }
      const j = await r.json();
      set({
        ent: j.tier === 'registered'
          ? {
              tier: 'registered', credits: Number(j.credits ?? 0),
              creditsKnown: j.creditsKnown !== false,
              userId: j.userId, organizationId: j.organizationId, displayName: j.displayName,
            }
          : ANONYMOUS,
        status: 'ready',
      });
    } catch {
      // 拿不到会话就是未登录，不做乐观假设
      set({ ent: ANONYMOUS, status: 'ready' });
    }
  },

  check: (cap) => checkCapability(get().ent, cap),
  noteConsumed: (cap) => set((s) => ({ ent: applyCost(s.ent, cap) })),
  setRemaining: (remaining) => set((s) => ({ ent: { ...s.ent, credits: remaining, creditsKnown: true } })),
}));

export { loginUrl, buyCreditsUrl };

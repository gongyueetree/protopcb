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
  ANONYMOUS, checkCapability, loginUrl, buyCreditsUrl,
  type Entitlements, type Capability, type OpenCapability, type CapabilityCheck,
} from '../design-core/entitlements';

/**
 * 会话状态。⚠ 鉴权后台故障 ≠ 未登录：前者要显示"服务暂不可用"，
 * 后者才显示"去登录" —— 把故障画成"登录解锁 AI"会误导用户去反复登录。
 */
export type SessionStatus = 'loading' | 'anonymous' | 'authenticated' | 'auth-unavailable' | 'expired';

interface EntitlementState {
  ent: Entitlements;
  status: 'idle' | 'loading' | 'ready';
  session: SessionStatus;
  sessionDetail?: string;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  check: (cap: Capability | OpenCapability) => CapabilityCheck;
  /** 服务端通过响应头回传的权威余额 */
  setRemaining: (remaining: number) => void;
}

export const useEntitlementStore = create<EntitlementState>((set, get) => ({
  ent: ANONYMOUS,
  status: 'idle',
  session: 'loading',

  refresh: async () => {
    set({ status: 'loading' });
    try {
      // 带 Cookie 请求：会话由 ezPLM / EEHub 签发，我们只读
      const r = await fetch('/api/session', { credentials: 'include' });
      if (!r.ok) { set({ ent: ANONYMOUS, status: 'ready', session: 'auth-unavailable', sessionDetail: `HTTP ${r.status}` }); return; }
      const j = await r.json();
      if (j.tier === 'registered') {
        set({
          ent: {
            tier: 'registered', credits: Number(j.credits ?? 0),
            creditsKnown: j.creditsKnown !== false,
            userId: j.userId, organizationId: j.organizationId, displayName: j.displayName,
          },
          status: 'ready', session: 'authenticated', sessionDetail: undefined,
        });
        return;
      }
      // 未登录 vs 后端故障 vs 会话过期：三种状态分开，不能都画成"去登录"
      const session: SessionStatus = j.reason === 'BACKEND_NOT_CONNECTED' || j.reason === 'AUTH_UPSTREAM_ERROR' || j.reason === 'AUTH_MISCONFIGURED'
        ? 'auth-unavailable'
        : j.reason === 'SESSION_EXPIRED' ? 'expired' : 'anonymous';
      set({ ent: ANONYMOUS, status: 'ready', session, sessionDetail: j.reason });
    } catch (e) {
      // 网络层拿不到 /api/session：是服务不可用，不是"用户没登录"
      set({ ent: ANONYMOUS, status: 'ready', session: 'auth-unavailable', sessionDetail: String((e as Error).message ?? e) });
    }
  },

  logout: async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch { /* 本地状态照样清 */ }
    // 退出后清掉私有缓存（参考设计/应用项目按租户缓存，切账号绝不能串）
    try { const { clearPrivateCaches } = await import('../providers/reference-design/private-cache'); clearPrivateCaches(); } catch { /* 模块缺失时忽略 */ }
    set({ ent: ANONYMOUS, status: 'ready', session: 'anonymous', sessionDetail: undefined });
  },

  check: (cap) => checkCapability(get().ent, cap),
  setRemaining: (remaining) => set((s) => ({ ent: { ...s.ent, credits: remaining, creditsKnown: true } })),
}));

export { loginUrl, buyCreditsUrl };

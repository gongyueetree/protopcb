/**
 * state/useAccessContext.ts
 * 调用方身份的**唯一**来源。
 *
 * 修复的问题：App.tsx / ComponentSearchPanel / AdvisorPanel 各写了一行
 * `const ctx = { userId: 'demo-user', organizationId: 'org-demo' }`。
 * 接入真实 ezPLM 后，所有请求仍然带着演示身份 —— 私有数据
 * （应用项目、组织物料、参考设计）的租户边界形同虚设。
 *
 * 现在统一走 providers.identity.getAccessContext()：
 * demo 模式下 Mock Provider 自然返回 demo-user，集成模式下是真实身份，
 * UI 一行都不许再自己编 ID。
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { getProviders } from '../providers/factory';
import type { AccessContext } from '../providers/types';

interface AccessState {
  ctx: AccessContext | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  load: () => Promise<void>;
}

export const useAccessStore = create<AccessState>((set, get) => ({
  ctx: null,
  status: 'idle',
  load: async () => {
    if (get().status === 'loading' || get().status === 'ready') return;
    set({ status: 'loading' });
    try {
      set({ ctx: await getProviders().identity.getAccessContext(), status: 'ready' });
    } catch (e) {
      // 拿不到身份时**不伪造** —— 返回 null，调用方据此降级为"仅公开数据"
      set({ ctx: null, status: 'error', error: String((e as Error).message ?? e) });
    }
  },
}));

/**
 * 取当前访问身份。首次调用触发加载。
 * 返回 null 表示尚未就绪或获取失败：此时调用方只能访问公开数据，
 * 不得退回到写死的 demo 身份。
 */
export function useAccessContext(): AccessContext | null {
  const ctx = useAccessStore((s) => s.ctx);
  const load = useAccessStore((s) => s.load);
  useEffect(() => { void load(); }, [load]);
  return ctx;
}

/** 非 React 环境（provider / 服务层）取身份 */
export async function getAccessContext(): Promise<AccessContext | null> {
  const st = useAccessStore.getState();
  if (st.status !== 'ready') await st.load();
  return useAccessStore.getState().ctx;
}

/** 供测试重置 */
export function __resetAccessContext() {
  useAccessStore.setState({ ctx: null, status: 'idle', error: undefined });
}

/** 兼容仍需同步 ctx 的调用点：未就绪时给出显式的匿名上下文，而不是假装是某个用户 */
export function anonymousContext(): AccessContext {
  return { userId: '', organizationId: '' } as AccessContext;
}

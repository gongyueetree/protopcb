/**
 * state/useAccessContext.ts
 * AccessContext（调用方身份）—— **派生自** entitlementStore 的会话状态，不是第二个身份源。
 *
 * 此前这里自己调 providers.identity.getAccessContext() 维护一份身份，与
 * entitlementStore（/api/session）并存：两处可能不一致（一处已登录、一处匿名）。
 * 现在唯一的服务端可信来源是 /api/session（entitlementStore.refresh），
 * 这里只把它投影成 AccessContext 形状供 provider 调用。
 */
import { useEffect } from 'react';
import { useEntitlementStore } from './entitlementStore';
import type { AccessContext } from '../providers/types';

function toAccessContext(ent: { tier: string; userId?: string; organizationId?: string }): AccessContext | null {
  if (ent.tier !== 'registered' || !ent.userId) return null;
  return { userId: ent.userId, organizationId: ent.organizationId ?? '' } as AccessContext;
}

/**
 * 取当前访问身份。返回 null = 匿名或会话未就绪：调用方只能访问公开数据，
 * 不得退回到任何写死的 demo 身份。
 */
export function useAccessContext(): AccessContext | null {
  const ent = useEntitlementStore((s) => s.ent);
  const status = useEntitlementStore((s) => s.status);
  const refresh = useEntitlementStore((s) => s.refresh);
  useEffect(() => { if (status === 'idle') void refresh(); }, [status, refresh]);
  return toAccessContext(ent);
}

/** 非 React 环境取身份（同一来源） */
export async function getAccessContext(): Promise<AccessContext | null> {
  const st = useEntitlementStore.getState();
  if (st.status === 'idle') await st.refresh();
  return toAccessContext(useEntitlementStore.getState().ent);
}


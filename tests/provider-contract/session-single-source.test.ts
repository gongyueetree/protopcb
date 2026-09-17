/**
 * Phase 6：身份只有一个来源 —— AccessContext 派生自 entitlementStore（/api/session）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
}

describe('AccessContext 派生自会话', () => {
  beforeEach(() => vi.resetModules());

  it('/api/session 返回已登录 → AccessContext 有 userId/organizationId', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ tier: 'registered', userId: 'u1', organizationId: 'org1', credits: 100 })));
    const { getAccessContext } = await import('../../src/state/useAccessContext');
    const ctx = await getAccessContext();
    expect(ctx).toEqual(expect.objectContaining({ userId: 'u1', organizationId: 'org1' }));
  });

  it('匿名 → null（不是任何写死的 demo 身份）', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ tier: 'anonymous' })));
    const { getAccessContext } = await import('../../src/state/useAccessContext');
    expect(await getAccessContext()).toBeNull();
  });

  it('鉴权后台故障 → null 且 session 标为 auth-unavailable（不是"未登录"）', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 502 }));
    const { getAccessContext } = await import('../../src/state/useAccessContext');
    const { useEntitlementStore } = await import('../../src/state/entitlementStore');
    expect(await getAccessContext()).toBeNull();
    expect(useEntitlementStore.getState().session).toBe('auth-unavailable');
  });
});

describe('没有第二个身份源', () => {
  it('factory 不再默认从 localStorage cc:token 读令牌', () => {
    const src = readFileSync(new URL('../../src/providers/factory.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/cc:token/);
    expect(src).toMatch(/HostAuthAdapter/);
  });
  it('useAccessContext 不再自己调 providers.identity', () => {
    const src = readFileSync(new URL('../../src/state/useAccessContext.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/getProviders\(\)\.identity/);
    expect(src).toMatch(/useEntitlementStore/);
  });
});

describe('匿名就是 null，不伪造空用户', () => {
  it('anonymousContext 已删除：不存在用空字符串 userId 冒充身份的出口', async () => {
    const mod = await import('../../src/state/useAccessContext');
    expect('anonymousContext' in mod).toBe(false);
  });
  it('公开方法签名接受 null，AI 方法只接受已认证身份', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../../src/providers/types/index.ts', import.meta.url), 'utf8'));
    expect(src).toMatch(/searchComponents\([^)]*ctx: AccessContext \| null\)/);
    expect(src).toMatch(/generateScheme\([^)]*ctx: AuthenticatedAccessContext\)/);
  });
  it('生产代码里没有空字符串身份', async () => {
    const { readdirSync, statSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../../src', import.meta.url).pathname;
    const walk = (d: string, out: string[] = []): string[] => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(p) && !/\.test\./.test(p)) out.push(p); } return out; };
    const offenders = walk(root).filter((p) => /userId:\s*''/.test(readFileSync(p, 'utf8'))).map((p) => p.split('/src/')[1]);
    expect(offenders).toEqual([]);
  });
});

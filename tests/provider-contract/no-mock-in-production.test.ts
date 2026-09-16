/**
 * P0-7：权限/计费类错误绝不能被 Mock 吞掉（假方案 = 假成功）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 让 i18n / store 在 Node 里能初始化
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
}

describe('AI 权限错误不回退 Mock', () => {
  beforeEach(() => { vi.resetModules(); });

  it('integrated 模式：Gemini 返回 402 → 抛 AiAccessError，不生成假方案', async () => {
    vi.doMock('../../src/config', () => ({ appConfig: { mode: 'integrated', providers: { components: 'ezplm', ai: 'gateway', identity: 'ezplm' } } }));
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/api/gemini?path=status')) return new Response(JSON.stringify({ configured: true }));
      if (u.includes('/api/ai')) return new Response(JSON.stringify({ error: 'Credit 余额不足', code: 'INSUFFICIENT_CREDITS', cost: 5 }), { status: 402 });
      return new Response('{}');
    });
    const { getProviders } = await import('../../src/providers/factory');
    const { AiAccessError } = await import('../../src/providers/ai-client');
    await expect(getProviders().ai.generateScheme({ prompt: 'USB 串口' }, { userId: 'u', organizationId: 'o' }))
      .rejects.toBeInstanceOf(AiAccessError);
  });

  it('integrated 模式：鉴权后台故障 → 抛错，不回 Mock', async () => {
    vi.doMock('../../src/config', () => ({ appConfig: { mode: 'integrated', providers: { components: 'ezplm', ai: 'gateway', identity: 'ezplm' } } }));
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = String(url);
      if (u.includes('path=status')) return new Response(JSON.stringify({ configured: true }));
      if (u.includes('/api/ai')) return new Response(JSON.stringify({ error: 'auth down', code: 'AUTH_UPSTREAM_ERROR' }), { status: 502 });
      return new Response('{}');
    });
    const { getProviders } = await import('../../src/providers/factory');
    const r = getProviders().ai.generateScheme({ prompt: 'USB 串口' }, { userId: 'u', organizationId: 'o' });
    await expect(r).rejects.toThrow();
    // 绝不是 source: 'mock'
    await r.then((out) => expect(out.source).not.toBe('mock')).catch(() => undefined);
  });

  it('demo 模式仍允许 Mock 回退（体验用）', async () => {
    vi.doMock('../../src/config', () => ({ appConfig: { mode: 'demo', providers: { components: 'mock', ai: 'mock', identity: 'demo' } } }));
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ configured: false })));
    const { getProviders } = await import('../../src/providers/factory');
    const out = await getProviders().ai.generateScheme({ prompt: 'USB 串口' }, { userId: 'demo-user', organizationId: 'org-demo' });
    expect(out.source).toBe('mock');
  });
});

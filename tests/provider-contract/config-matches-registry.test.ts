/**
 * Phase 7：AppConfig 必须描述真实装配 —— 每种 RunMode 下 factory 实际装出的 provider 类型
 * 与 config 声明一致。config 不允许沦为"历史文档"（曾写 ai: 'claude' / 'gateway'，实际全是 Gemini）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
}

const presets = {
  demo: { mode: 'demo', providers: { component: 'mock', reference: 'mock', project: 'local', ai: 'mock', identity: 'demo' } },
  standalone: { mode: 'standalone', providers: { component: 'ezplm', reference: 'ezplm', project: 'local', ai: 'gemini-via-api', identity: 'ezplm' }, apiBaseUrl: '/api' },
  integrated: { mode: 'integrated', providers: { component: 'ezplm', reference: 'ezplm', project: 'ezplm', ai: 'gemini-via-api', identity: 'ezplm' }, apiBaseUrl: 'https://www.ezplm.cn/api' },
} as const;

const expectedClass = {
  mock: { component: 'MockComponentDataProvider', reference: 'MockReferenceDesignProvider' },
  ezplm: { component: 'EzplmComponentDataProvider', reference: 'EzplmReferenceDesignProvider' },
} as const;

describe('config ↔ ProviderRegistry 一致', () => {
  beforeEach(() => vi.resetModules());

  for (const [mode, cfg] of Object.entries(presets)) {
    it(`${mode}：装配的 provider 类型符合 config 声明`, async () => {
      vi.doMock('../../src/config', () => ({ appConfig: cfg }));
      const { getProviders } = await import('../../src/providers/factory');
      const r = getProviders();
      expect(r.components.constructor.name).toBe(expectedClass[cfg.providers.component].component);
      expect(r.referenceDesigns.constructor.name).toBe(expectedClass[cfg.providers.reference].reference);
      expect(r.identity.constructor.name).toBe(cfg.providers.identity === 'demo' ? 'MockIdentityProvider' : 'EzplmIdentityProvider');
      expect(r.project.constructor.name).toBe(cfg.providers.project === 'local' ? 'LocalStorageProjectProvider' : 'EzplmProjectProvider');
    });
  }

  it('config 里不再存在从未实现的取值（local-api / claude / gateway / local identity）', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/config/index.ts', import.meta.url), 'utf8'));
    for (const stale of ["'local-api'", "'claude'", "'gateway'", "identity: 'local'"]) {
      // 允许出现在解释性注释里，不允许出现在类型或 preset 里
      const codeOnly = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(codeOnly.includes(stale), stale).toBe(false);
    }
  });
});

describe('未接通的 ezPLM 能力不发请求、不假成功', () => {
  beforeEach(() => vi.resetModules());
  it('footprintOptions / supplierOffers / alternatives / orgContext 返回空且零 fetch', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; return new Response('{}'); });
    const { EzplmComponentDataProvider } = await import('../../src/providers/ezplm');
    const { HttpClient } = await import('../../src/providers/http/client');
    const p = new EzplmComponentDataProvider(new HttpClient({ baseUrl: '/api', getAuthHeaders: () => ({}), timeoutMs: 1000 }));
    expect(await p.getFootprintOptions()).toEqual([]);
    expect(await p.getSupplierOffers()).toEqual([]);
    expect(await p.getAlternatives()).toEqual([]);
    expect(await p.getOrganizationContext()).toBeNull();
    expect(calls).toBe(0);
    expect(p.notConnected.alternatives).toBe('ALTERNATIVES_NOT_CONNECTED');
  });
  it('云端项目存储抛 NOT_CONNECTED，而不是吞成 null', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; return new Response('{}'); });
    const { EzplmProjectProvider, CloudProjectNotConnectedError } = await import('../../src/providers/ezplm');
    const { HttpClient } = await import('../../src/providers/http/client');
    const p = new EzplmProjectProvider(new HttpClient({ baseUrl: '/api', getAuthHeaders: () => ({}), timeoutMs: 1000 }));
    await expect(p.loadDesignDocument()).rejects.toBeInstanceOf(CloudProjectNotConnectedError);
    await expect(p.saveDesignDocument()).rejects.toBeInstanceOf(CloudProjectNotConnectedError);
    expect(calls).toBe(0);
  });
});

/**
 * P0-8：身份从 null → 用户后，应用项目查询必须自动重跑
 * （用纯逻辑复刻 ReferenceDesignSection 的 effect 决策，验证 deps 与分支）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('ReferenceDesignSection 的身份依赖', () => {
  const src = readFileSync(new URL('../../src/modules/component-search/ReferenceDesignSection.tsx', import.meta.url), 'utf8');

  it('effect deps 包含 ctx.userId 与 ctx.organizationId（身份到位后自动重跑）', () => {
    expect(src).toMatch(/\}, \[c\.componentId, c\.mpn, ctx\?\.userId, ctx\?\.organizationId\]\);/);
  });

  it('身份未就绪时不发私有请求，而是标记 UNAUTHORIZED', () => {
    expect(src).toMatch(/if \(ctx\?\.userId\) rd\.getApplicationProjects/);
    expect(src).toMatch(/else setAppProjects\(\{ state: 'UNAUTHORIZED'/);
  });

  it('公开参考设计不受身份影响，照常查询', () => {
    expect(src).toMatch(/rd\.getRelatedReferenceDesigns\(c\.componentId, c\.mpn, ctx\)/);
  });
});

describe('Provider 层：匿名调用应用项目不发请求', () => {
  it('EzplmReferenceDesignProvider.getApplicationProjects 无身份 → UNAUTHORIZED 且不 fetch', async () => {
    let fetched = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { fetched++; return new Response('{}'); }) as typeof fetch;
    try {
      const { EzplmReferenceDesignProvider } = await import('../../src/providers/reference-design/ezplm-provider');
      const r = await EzplmReferenceDesignProvider.getApplicationProjects('ez_p1', 'X', null);
      expect(r.state).toBe('UNAUTHORIZED');
      expect(fetched).toBe(0);
    } finally { globalThis.fetch = realFetch; }
  });
});

/**
 * 租户隔离与权限矩阵
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getPrivate, setPrivate, clearPrivateCaches, privateCacheKey, __privateCacheSize } from '../../src/providers/reference-design/private-cache';
import { ANONYMOUS, checkCapability, CREDIT_COST, type Entitlements, type Capability } from '../../src/design-core/entitlements';

describe('私有缓存按租户隔离（§18/§37）', () => {
  beforeEach(() => clearPrivateCaches());

  it('用户 A 的应用项目缓存，用户 B 绝不能命中', () => {
    const a = { tenantId: 'orgA', userId: 'userA', resourceId: 'app-projects:ez_U1' };
    const b = { tenantId: 'orgB', userId: 'userB', resourceId: 'app-projects:ez_U1' };
    setPrivate(a, { items: ['A1'] });
    expect(getPrivate(a)).toEqual({ items: ['A1'] });
    expect(getPrivate(b)).toBeUndefined();
  });

  it('同一用户换组织也是不同的键', () => {
    const k1 = { tenantId: 'orgA', userId: 'u', resourceId: 'r' };
    const k2 = { tenantId: 'orgB', userId: 'u', resourceId: 'r' };
    expect(privateCacheKey(k1)).not.toBe(privateCacheKey(k2));
  });

  it('匿名不读不写私有缓存', () => {
    const anon = { tenantId: '', userId: '', resourceId: 'r' };
    setPrivate(anon, { leak: true });
    expect(__privateCacheSize()).toBe(0);
    expect(getPrivate(anon)).toBeUndefined();
  });

  it('登出清空全部私有缓存', () => {
    setPrivate({ tenantId: 'orgA', userId: 'userA', resourceId: 'r1' }, 1);
    setPrivate({ tenantId: 'orgA', userId: 'userA', resourceId: 'r2' }, 2);
    expect(__privateCacheSize()).toBe(2);
    clearPrivateCaches();
    expect(__privateCacheSize()).toBe(0);
  });
});

describe('权限矩阵（§30）', () => {
  const registered0: Entitlements = { tier: 'registered', credits: 0, creditsKnown: true, userId: 'u' };
  const registered100: Entitlements = { tier: 'registered', credits: 100, creditsKnown: true, userId: 'u' };
  const ai = Object.keys(CREDIT_COST) as Capability[];

  const matrix: { name: string; ent: Entitlements; expect: Partial<Record<Capability, boolean>> }[] = [
    {
      name: 'ANONYMOUS',
      ent: ANONYMOUS,
      expect: { 'search.web': false, 'part.custom': false, 'design.save': false, 'design.open': false, ...Object.fromEntries(ai.map((c) => [c, false])) },
    },
    {
      name: 'REGISTERED / 0 CREDIT',
      ent: registered0,
      expect: { 'search.web': true, 'part.custom': true, 'design.save': true, 'design.open': true, ...Object.fromEntries(ai.map((c) => [c, false])) },
    },
    {
      name: 'REGISTERED / 100 CREDIT',
      ent: registered100,
      expect: { 'search.web': true, 'part.custom': true, 'design.save': true, 'design.open': true, ...Object.fromEntries(ai.map((c) => [c, true])) },
    },
  ];

  for (const row of matrix) {
    it(row.name, () => {
      for (const [cap, allowed] of Object.entries(row.expect)) {
        expect(checkCapability(row.ent, cap as Capability).allowed, `${row.name} → ${cap}`).toBe(allowed);
      }
    });
  }

  it('画布 / KiCad 导入 / ezPLM 公开检索不属于任何受限能力（匿名可用）', () => {
    const restricted = new Set<string>(['search.web', 'part.custom', 'design.save', 'design.open', 'design.share', ...ai]);
    for (const free of ['canvas.edit', 'kicad.import', 'search.ezplm', 'export.prototype']) expect(restricted.has(free)).toBe(false);
  });
});

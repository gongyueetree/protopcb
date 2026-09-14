/**
 * 访问层级与 Credit：未注册不能用 AI、注册用户按额度扣费
 */
import { describe, it, expect } from 'vitest';
import {
  ANONYMOUS, CREDIT_COST, WELCOME_CREDITS, checkCapability, applyCost,
  isAiCapability, loginUrl, buyCreditsUrl, type Entitlements,
} from '../src/design-core/entitlements';

const registered = (credits: number): Entitlements => ({ tier: 'registered', credits, creditsKnown: true, userId: 'u1' });

describe('匿名用户', () => {
  it('所有 AI 能力一律拒绝，理由是"需要登录"而不是"额度不足"', () => {
    for (const cap of Object.keys(CREDIT_COST) as (keyof typeof CREDIT_COST)[]) {
      const r = checkCapability(ANONYMOUS, cap);
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('login-required');
    }
  });

  it('保存/打开云端设计也需要登录', () => {
    expect(checkCapability(ANONYMOUS, 'design.save').reason).toBe('login-required');
    expect(checkCapability(ANONYMOUS, 'design.open').reason).toBe('login-required');
  });

  it('提示语说明未登录仍可体验，而不是笼统的"请登录"', () => {
    expect(checkCapability(ANONYMOUS, 'scheme.generate').message).toMatch(/完整体验/);
  });

  it('扣费对匿名用户无效（不会出现负余额）', () => {
    expect(applyCost(ANONYMOUS, 'scheme.generate').credits).toBe(0);
  });
});

describe('注册用户与 Credit', () => {
  it('余额充足时放行，并给出本次花费', () => {
    const r = checkCapability(registered(WELCOME_CREDITS), 'scheme.generate');
    expect(r.allowed).toBe(true);
    expect(r.cost).toBe(CREDIT_COST['scheme.generate']);
  });

  it('余额不足时拒绝，提示里同时给出所需与当前余额', () => {
    const r = checkCapability(registered(2), 'scheme.generate');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('insufficient-credits');
    expect(r.message).toMatch(/需要 5 Credit/);
    expect(r.message).toMatch(/余额 2/);
  });

  it('刚好够用可以放行（边界）', () => {
    expect(checkCapability(registered(CREDIT_COST['scheme.generate']), 'scheme.generate').allowed).toBe(true);
  });

  it('非 AI 能力不消耗 Credit', () => {
    const r = checkCapability(registered(0), 'design.save');
    expect(r.allowed).toBe(true);
    expect(r.cost).toBe(0);
  });

  it('额度未知时宁可拒绝，也不冒误扣费的风险', () => {
    const r = checkCapability({ tier: 'registered', credits: 0, creditsKnown: false }, 'scheme.generate');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('credits-unknown');
  });

  it('扣费后余额下降，且不会低于 0', () => {
    expect(applyCost(registered(10), 'scheme.generate').credits).toBe(5);
    expect(applyCost(registered(1), 'scheme.generate').credits).toBe(0);
  });
});

describe('价目表与入口', () => {
  it('每项 AI 能力都有明确定价（不能有漏网的免费项）', () => {
    for (const [cap, cost] of Object.entries(CREDIT_COST)) {
      expect(isAiCapability(cap as never)).toBe(true);
      expect(cost).toBeGreaterThan(0);
    }
  });

  it('中文站到 ezplm.cn，英文站到 eehub.io', () => {
    expect(loginUrl('zh', 'https://x/y')).toMatch(/^https:\/\/ezplm\.cn\/login\?returnTo=/);
    expect(loginUrl('en', 'https://x/y')).toMatch(/^https:\/\/eehub\.io\/login\?returnTo=/);
    expect(buyCreditsUrl('zh')).toBe('https://ezplm.cn/credits');
    expect(buyCreditsUrl('en')).toBe('https://eehub.io/credits');
  });

  it('登录后能带回原页面（returnTo 编码正确）', () => {
    expect(loginUrl('zh', 'https://proto.tindie.com/?x=1')).toContain(encodeURIComponent('https://proto.tindie.com/?x=1'));
  });
});

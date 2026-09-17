/**
 * design-core/entitlements/index.ts
 * 访问层级与额度 —— 决定"谁能用什么"的**唯一**定义。
 *
 * 两档：
 *   anonymous   未登录。可以完整体验画布、导入 KiCad、查看器件库、导出原型文件，
 *               但不能调用任何消耗我们算力/配额的 AI 功能，也不能保存到云端。
 *   registered  已登录（ezplm.cn / eehub.io）。赠送起始 Credit，用完需购买。
 *               可保存、可访问自己空间里的设计。
 *
 * ⚠ 这里只是**判定规则**。真正的拦截必须在服务端（api/_lib/session.js）：
 * 前端藏按钮挡不住直接打 /api/gemini 的人，而那正是"防止乱刷"要防的。
 * 本模块的价值是让 UI 的提示与服务端的判定用同一套语义，不会互相矛盾。
 */

import aiContract from '../../../contracts/ai-operations.json';

export type AccessTier = 'anonymous' | 'registered';

/** 需要消耗 Credit 的能力 —— 每一项都对应一次真实的上游付费调用 */
export type AiCapability =
  | 'scheme.generate'      // AI 生成方案
  | 'scheme.revise'        // 方案多轮修改
  | 'subcircuit.recommend' // 子电路推荐
  | 'advisor.analyze'      // AI 顾问分析
  | 'block.analyze'        // 框图架构分析
  | 'part.extract'         // 从 URL/PDF 提取器件
  | 'bom.estimate'         // BOM AI 估价
  | 'symbol.generate';     // 符号生成

/** 不耗 Credit、但需要登录的能力 */
export type AccountCapability =
  | 'design.save'          // 保存到云端空间
  | 'design.open'          // 打开自己空间里的设计
  | 'design.share'         // 分享
  // 下面两项不耗 Credit，但同样消耗我们的上游配额 / 需要身份边界：
  | 'part.custom';         // 定制器件（建库属于账户资产，且提取走 AI）

/**
 * 匿名也可用的能力。分销商/器件库检索**不消耗 AI Token**，只耗上游 API 配额，
 * 未登录也放行（限频在服务端，每小时 ANON_SEARCH_PER_HOUR 次），
 * 否则"未注册可完整体验"这条就不成立。
 */
export type OpenCapability = 'search.web';

export type Capability = AiCapability | AccountCapability;

/**
 * 每次调用扣多少 Credit —— 从 contracts/ai-operations.json 生成，与服务端注册表同源。
 * 这里只用于前端提示；实际扣费以服务端为准。
 */
export const CREDIT_COST: Record<AiCapability, number> = Object.fromEntries(
  Object.entries(aiContract.operations).map(([k, v]) => [k, (v as { cost: number }).cost]),
) as Record<AiCapability, number>;

/** 新注册用户赠送的体验额度 */
export const WELCOME_CREDITS: number = aiContract.welcomeCredits;

export interface Entitlements {
  tier: AccessTier;
  /** 剩余 Credit；anonymous 恒为 0 */
  credits: number;
  /** 额度数据是否来自服务端。false 表示后端未接通，UI 必须如实说明 */
  creditsKnown: boolean;
  userId?: string;
  organizationId?: string;
  displayName?: string;
}

export const ANONYMOUS: Entitlements = { tier: 'anonymous', credits: 0, creditsKnown: true };

export type DenyReason =
  | 'login-required'       // 未登录
  | 'insufficient-credits' // 登录了但额度不够
  | 'credits-unknown';     // 后端未接通，无法确认额度

export interface CapabilityCheck {
  allowed: boolean;
  reason?: DenyReason;
  /** 本次需要消耗的 Credit（不耗则为 0） */
  cost: number;
  /** 面向用户的说明 */
  message?: string;
}

const AI_CAPS = new Set<string>(Object.keys(CREDIT_COST));
export const isAiCapability = (c: Capability): c is AiCapability => AI_CAPS.has(c);

/**
 * 能否使用某能力。
 * 判定顺序：登录 → 额度 —— 顺序很重要，未登录时不该说"额度不足"。
 */
export function checkCapability(ent: Entitlements, cap: Capability | OpenCapability): CapabilityCheck {
  // 检索类能力匿名可用（服务端限频）
  if (cap === 'search.web') return { allowed: true, cost: 0 };
  const cost = isAiCapability(cap as Capability) ? CREDIT_COST[cap as AiCapability] : 0;

  if (ent.tier === 'anonymous') {
    return {
      allowed: false, cost, reason: 'login-required',
      message: isAiCapability(cap)
        ? 'AI 功能需要登录后使用。未登录可以完整体验画布、导入工程与导出原型文件。'
        : cap === 'part.custom'
            ? '定制器件需要登录后使用。（当前版本定制器件保存在本浏览器；云端账户器件库尚未接通）'
            : '保存与云端空间需要登录后使用。',
    };
  }

  if (!isAiCapability(cap)) return { allowed: true, cost: 0 };

  if (!ent.creditsKnown) {
    return { allowed: false, cost, reason: 'credits-unknown', message: '暂时无法确认 Credit 余额（额度服务未接通），请稍后再试。' };
  }
  if (ent.credits < cost) {
    return {
      allowed: false, cost, reason: 'insufficient-credits',
      message: `本次操作需要 ${cost} Credit，当前余额 ${ent.credits}。可购买 Credit 后继续。`,
    };
  }
  return { allowed: true, cost };
}

/** 扣费后的余额（纯函数；真实扣费由服务端账本完成，这里只用于乐观更新 UI） */
export function applyCost(ent: Entitlements, cap: Capability): Entitlements {
  const cost = isAiCapability(cap) ? CREDIT_COST[cap] : 0;
  if (!cost || ent.tier === 'anonymous') return ent;
  return { ...ent, credits: Math.max(0, ent.credits - cost) };
}

/** 登录入口：中文站 ezplm.cn，英文站 eehub.io */
export function loginUrl(lang: 'zh' | 'en', returnTo?: string): string {
  const base = lang === 'en' ? 'https://eehub.io/login' : 'https://ezplm.cn/login';
  const ret = returnTo ?? (typeof location !== 'undefined' ? location.href : '');
  return ret ? `${base}?returnTo=${encodeURIComponent(ret)}` : base;
}

/** 购买 Credit 入口 */
export function buyCreditsUrl(lang: 'zh' | 'en'): string {
  return lang === 'en' ? 'https://eehub.io/credits' : 'https://ezplm.cn/credits';
}

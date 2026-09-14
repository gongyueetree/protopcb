/**
 * design-core/trust/index.ts
 * 器件可信度的**唯一**统计口径。
 *
 * 修复的问题：此前 PipelineBar / OverviewPanel / ReviewPanel / 导出确认
 * 各写一遍 `components.filter(...)`，而且大多只数 PLACEHOLDER。
 * 结果同一个项目里，审查页说"全部型号已在器件库精确匹配"，
 * 器件数据可信度那栏却显示 24 个 CANDIDATE —— 两句话都来自我们自己，互相矛盾。
 *
 * 规则：任何模块要谈"型号核对到什么程度"，都必须调 summarizeTrust()。
 */
import type { PlacedComponent } from '../document/types';

export type TrustLevel = 'VERIFIED' | 'CANDIDATE' | 'PLACEHOLDER';

export interface TrustSummary {
  total: number;
  verified: number;
  candidate: number;
  placeholder: number;
  /** 还需要人工处理的条数（候选 + 未验证） */
  needsReview: number;
  /**
   * 工程就绪：所有型号都经过器件库精确匹配。
   * 注意 CANDIDATE 也算**未就绪** —— 近似料没人确认过，不能当成核对完毕。
   */
  engineeringReady: boolean;
  /** 需要人工处理的器件位号（供 UI 直接列出，不必再自己过滤） */
  needsReviewRefs: string[];
}

/** 器件的可信等级：没有 trust 字段一律视为未验证，不做乐观假设 */
export function trustLevelOf(c: Pick<PlacedComponent, 'trust'>): TrustLevel {
  return c.trust?.level ?? 'PLACEHOLDER';
}

export function summarizeTrust(components: PlacedComponent[]): TrustSummary {
  let verified = 0, candidate = 0, placeholder = 0;
  const needsReviewRefs: string[] = [];
  for (const c of components) {
    const lv = trustLevelOf(c);
    if (lv === 'VERIFIED') verified++;
    else {
      if (lv === 'CANDIDATE') candidate++; else placeholder++;
      needsReviewRefs.push(c.reference);
    }
  }
  const needsReview = candidate + placeholder;
  return {
    total: components.length,
    verified, candidate, placeholder, needsReview,
    engineeringReady: components.length > 0 && needsReview === 0,
    needsReviewRefs,
  };
}

/** 一句话结论，供流程条/审查页共用，杜绝各写一套措辞 */
export function trustHeadline(s: TrustSummary): string {
  if (!s.total) return '无器件';
  if (s.engineeringReady) return '型号均已核对';
  const parts: string[] = [];
  if (s.candidate) parts.push(`${s.candidate} 个待人工确认`);
  if (s.placeholder) parts.push(`${s.placeholder} 个未验证`);
  return parts.join(' · ');
}

/** 导出门禁：未就绪时必须显式提示风险，不能静默导出成"工程就绪" */
export interface ExportGate {
  engineeringReady: boolean;
  /** 阻断性说明；engineeringReady 时为空 */
  warning?: string;
}

export function exportGate(s: TrustSummary): ExportGate {
  if (s.engineeringReady) return { engineeringReady: true };
  const bits: string[] = [];
  if (s.candidate) bits.push(`${s.candidate} 个候选型号未经人工确认`);
  if (s.placeholder) bits.push(`${s.placeholder} 个型号未在器件库验证`);
  if (!s.total) bits.push('设计中没有器件');
  return {
    engineeringReady: false,
    warning: `${bits.join('，')}。导出的是原型文件，不能直接投产。`,
  };
}

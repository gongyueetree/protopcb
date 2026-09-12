/**
 * providers/reference-design/ranking.ts
 * Reference Design 排序（方案 §十一）：纯函数，可单测。
 *
 * 优先级：用户项目 > 组织项目 > 量产验证 > 原型实测 > 厂家 Eval/Reference
 *        > Simulation Verified > 公开 KiCad/Altium > PDF 提取 > AI Generated
 * 同档内再按：anchor MPN 精确匹配 > application 相似 > 资产完整度 > 时间新旧 > 验证置信度。
 */
import type { ReferenceDesign } from './schema';

/** 来源档位（越小越优先） */
function sourceTier(d: ReferenceDesign): number {
  switch (d.sourceType) {
    case 'USER_PROJECT': return 0;
    case 'ORGANIZATION_PROJECT': return 1;
    case 'EZPLM_PROJECT': return 2;
    default: break;
  }
  // 公开来源按验证等级分档
  switch (d.verification.level) {
    case 'PRODUCTION_VERIFIED': return 3;
    case 'PROTOTYPE_VERIFIED': return 4;
    case 'VENDOR_REFERENCE': return 5;
    case 'SIMULATION_VERIFIED': return 6;
    default: break;
  }
  switch (d.sourceType) {
    case 'EVALUATION_BOARD': return 5;      // 厂家评估板与 Vendor Reference 同档
    case 'KICAD_PROJECT':
    case 'ALTIUM_PROJECT': return 7;
    case 'PDF_SCHEMATIC':
    case 'DATASHEET_APPLICATION': return 8;
    default: break;
  }
  return d.verification.level === 'AI_GENERATED' ? 9 : 8;
}

const normMpn = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface RankContext {
  /** 当前锚点 MPN */
  mpn: string;
  /** 用户需求/应用描述（可选，用于 application 相似度） */
  application?: string;
}

/** 单条评分（越大越靠前；导出以便测试与 UI 展示原因） */
export function scoreReferenceDesign(d: ReferenceDesign, ctx: RankContext): number {
  let score = (10 - sourceTier(d)) * 1000;                    // 档位主导

  // anchor MPN 精确命中
  const target = normMpn(ctx.mpn);
  if (d.anchorMpns.some((m) => normMpn(m) === target)) score += 400;
  else if (d.anchorMpns.some((m) => normMpn(m).startsWith(target) || target.startsWith(normMpn(m)))) score += 150;

  // application 关键词朴素相似（词交集；无 LLM，可解释）
  if (ctx.application && d.application) {
    const a = new Set(ctx.application.toLowerCase().split(/[\s,，、/]+/).filter((w) => w.length > 1));
    const b = d.application.toLowerCase();
    let hits = 0;
    for (const w of a) if (b.includes(w)) hits++;
    score += Math.min(120, hits * 40);
  }

  // 资产完整度：能进入设计引擎的资产权重高
  const A = d.availableAssets;
  score += (A.schematic ? 40 : 0) + (A.pcb ? 30 : 0) + (A.bom ? 15 : 0)
    + (A.simulation ? 20 : 0) + (A.placement ? 15 : 0) + (A.pdf ? 5 : 0) + (A.step ? 5 : 0);

  // 验证置信度
  score += Math.round(d.verification.confidence * 50);

  // 时间新旧（有 updatedAt/lastUsedAt 的略加分；一年内线性衰减）
  const ts = Date.parse(d.lastUsedAt ?? d.updatedAt ?? '');
  if (Number.isFinite(ts)) {
    const ageDays = (Date.now() - ts) / 86400000;
    score += Math.max(0, Math.round(30 - Math.min(30, ageDays / 12)));
  }
  return score;
}

export function rankReferenceDesigns(list: ReferenceDesign[], ctx: RankContext): ReferenceDesign[] {
  return [...list]
    .map((d) => ({ d, s: scoreReferenceDesign(d, ctx) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.d);
}

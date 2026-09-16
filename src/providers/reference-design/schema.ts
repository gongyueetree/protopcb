/**
 * Reference Design Intelligence —— 统一数据模型（方案 §四/五/十三）。
 *
 * 核心区分：
 *   Application Projects（用户/组织私有历史项目）≠ Related Reference Designs（公开设计）。
 *   两者共用 ReferenceDesign 模型，但 sourceType 必须保留来源类别，UI/排序/权限都依赖它。
 *
 * 所有跨网络数据进入前必须过 Zod（safeParseReferenceDesign / safeParseApplicationProjects）。
 */
import { z } from 'zod';
import { REFERENCE_DESIGN_SOURCE_TYPES, VERIFICATION_LEVELS, EvidenceSchema } from '../../design-core/fragment/schema';
import type { ReferenceDesignSourceType, VerificationLevel, Evidence } from '../../design-core/fragment/schema';


/** 私有来源（Application Projects）——权限上绝不能进入公共参考库 */
export const PRIVATE_SOURCE_TYPES: readonly ReferenceDesignSourceType[] = ['USER_PROJECT', 'ORGANIZATION_PROJECT', 'EZPLM_PROJECT'];



export const AvailableAssetsSchema = z.object({
  schematic: z.boolean(),
  pcb: z.boolean(),
  bom: z.boolean(),
  pdf: z.boolean(),
  step: z.boolean(),
  simulation: z.boolean(),
  placement: z.boolean(),
});
export type AvailableAssets = z.infer<typeof AvailableAssetsSchema>;

export const ReferenceDesignSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  sourceType: z.enum(REFERENCE_DESIGN_SOURCE_TYPES),
  sourceSystem: z.enum(['EZPLM', 'GITHUB', 'VENDOR', 'PUBLIC', 'USER_UPLOAD']),
  ownerType: z.enum(['USER', 'ORGANIZATION', 'PUBLIC']).optional(),
  projectId: z.string().max(120).optional(),
  projectVersion: z.string().max(40).optional(),
  bomId: z.string().max(80).optional(),
  sourceUrl: z.string().url().max(500).optional(),
  imageUrl: z.string().url().max(500).optional(),
  description: z.string().max(1000).optional(),
  application: z.string().max(200).optional(),
  anchorMpns: z.array(z.string().max(64)).max(50),
  /** 该项目 BOM 中锚点器件的用量（Application Project 特有） */
  anchorQuantity: z.number().int().positive().optional(),
  componentCount: z.number().int().nonnegative().optional(),
  boardSize: z.object({ widthMm: z.number().positive(), heightMm: z.number().positive() }).optional(),
  availableAssets: AvailableAssetsSchema,
  verification: z.object({
    level: z.enum(VERIFICATION_LEVELS),
    confidence: z.number().min(0).max(1),
    evidence: z.array(EvidenceSchema).max(50),
  }),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
});
export type ReferenceDesign = z.infer<typeof ReferenceDesignSchema>;

export const NO_ASSETS: AvailableAssets = { schematic: false, pcb: false, bom: false, pdf: false, step: false, simulation: false, placement: false };

// 参考设计词汇表（来源类型 / 验证等级 / 证据）与 CircuitFragment 都定义在 Domain
export { REFERENCE_DESIGN_SOURCE_TYPES, VERIFICATION_LEVELS, EvidenceSchema };
export type { ReferenceDesignSourceType, VerificationLevel, Evidence };

/* ---------------- CircuitFragment：定义在 Domain（design-core/fragment/schema），这里只转出 ---------------- */
export {
  FragmentComponentSchema, FragmentNetSchema, FragmentPortSchema, CircuitFragmentSchema,
} from '../../design-core/fragment/schema';
export type { FragmentComponent, FragmentNet, FragmentPort, CircuitFragment } from '../../design-core/fragment/schema';

/* ---------------- 解析入口 ---------------- */

export function safeParseReferenceDesigns(raw: unknown): ReferenceDesign[] {
  if (!Array.isArray(raw)) return [];
  const out: ReferenceDesign[] = [];
  for (const item of raw) {
    const r = ReferenceDesignSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

/* ---------------- 加载状态（方案 §四十七）---------------- */

export type ReferenceLoadState = 'IDLE' | 'LOADING' | 'READY' | 'ERROR' | 'UNAUTHORIZED' | 'BACKEND_NOT_CONNECTED';

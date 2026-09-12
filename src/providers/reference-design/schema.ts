/**
 * providers/reference-design/schema.ts
 * Reference Design Intelligence —— 统一数据模型（方案 §四/五/十三）。
 *
 * 核心区分：
 *   Application Projects（用户/组织私有历史项目）≠ Related Reference Designs（公开设计）。
 *   两者共用 ReferenceDesign 模型，但 sourceType 必须保留来源类别，UI/排序/权限都依赖它。
 *
 * 所有跨网络数据进入前必须过 Zod（safeParseReferenceDesign / safeParseApplicationProjects）。
 */
import { z } from 'zod';

export const REFERENCE_DESIGN_SOURCE_TYPES = [
  'USER_PROJECT', 'ORGANIZATION_PROJECT', 'EZPLM_PROJECT',
  'VENDOR_REFERENCE', 'EVALUATION_BOARD', 'MODULE',
  'KICAD_PROJECT', 'ALTIUM_PROJECT', 'PDF_SCHEMATIC', 'DATASHEET_APPLICATION',
  'GITHUB', 'TINDIE', 'SEEED', 'HACKSTER', 'HACKADAY', 'OTHER_PUBLIC',
] as const;
export type ReferenceDesignSourceType = (typeof REFERENCE_DESIGN_SOURCE_TYPES)[number];

/** 私有来源（Application Projects）——权限上绝不能进入公共参考库 */
export const PRIVATE_SOURCE_TYPES: readonly ReferenceDesignSourceType[] = ['USER_PROJECT', 'ORGANIZATION_PROJECT', 'EZPLM_PROJECT'];

export const VERIFICATION_LEVELS = [
  'PRODUCTION_VERIFIED', 'PROTOTYPE_VERIFIED', 'SIMULATION_VERIFIED',
  'VENDOR_REFERENCE', 'EXTRACTED', 'AI_GENERATED',
] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export const EvidenceSchema = z.object({
  kind: z.string().min(1).max(40),                 // 'schematic' | 'pcb' | 'bom' | 'pdf-region' | 'api' …
  sourceFile: z.string().max(300).optional(),
  page: z.number().int().positive().optional(),
  boundingBox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  sourceText: z.string().max(500).optional(),
  detail: z.string().max(300).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

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

/* ---------------- CircuitFragment（方案 §十三）---------------- */

export const FragmentComponentSchema = z.object({
  instanceId: z.string().min(1),
  reference: z.string().min(1).max(24),
  mpn: z.string().max(64),
  category: z.string().max(24),
  footprint: z.string().max(120).optional(),
  /** 提取分类：为什么被纳入 fragment */
  role: z.enum(['ANCHOR', 'DECOUPLING', 'POWER_LOCAL', 'CLOCK', 'FEEDBACK', 'FILTER', 'SUPPORTING', 'CONNECTED_PASSIVE']),
});
export type FragmentComponent = z.infer<typeof FragmentComponentSchema>;

export const FragmentNetSchema = z.object({
  netId: z.number().int(),
  name: z.string().max(120),
  kind: z.enum(['SIGNAL', 'POWER', 'GROUND', 'CLOCK']),
  /** net 上属于 fragment 的连接点（reference.pad） */
  pins: z.array(z.string().max(40)).max(200),
});
export type FragmentNet = z.infer<typeof FragmentNetSchema>;

/** fragment 边界端口：net 同时连接 fragment 内外 → 对外接口 */
export const FragmentPortSchema = z.object({
  netId: z.number().int(),
  name: z.string().max(120),
  kind: z.enum(['SIGNAL', 'POWER', 'GROUND', 'CLOCK']),
  /** fragment 外部还挂着的位号（说明这是拼接点） */
  externalRefs: z.array(z.string().max(24)).max(60),
});
export type FragmentPort = z.infer<typeof FragmentPortSchema>;

export const CircuitFragmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  anchorComponent: z.object({ mpn: z.string().max(64), reference: z.string().max(24).optional() }),
  sourceDesignId: z.string().max(120),
  sourceProjectId: z.string().max(120).optional(),
  sourceType: z.enum(REFERENCE_DESIGN_SOURCE_TYPES),
  components: z.array(FragmentComponentSchema).min(1).max(200),
  nets: z.array(FragmentNetSchema).max(300),
  ports: z.array(FragmentPortSchema).max(100),
  trust: z.object({ level: z.enum(VERIFICATION_LEVELS), confidence: z.number().min(0).max(1) }),
  evidence: z.array(EvidenceSchema).max(50),
});
export type CircuitFragment = z.infer<typeof CircuitFragmentSchema>;

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

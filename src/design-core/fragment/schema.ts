/**
 * design-core/fragment/schema.ts
 * CircuitFragment 的运行时 schema 与类型 —— 归 Domain 所有。
 * 此前定义在 providers/reference-design/schema.ts，导致 design-core/fragment/extract.ts
 * 反向依赖 Infrastructure；providers 侧现在只 re-export。
 */
import { z } from 'zod';

/* ---------------- 参考设计词汇表 ---------------- */
export const REFERENCE_DESIGN_SOURCE_TYPES = [
  'USER_PROJECT', 'ORGANIZATION_PROJECT', 'EZPLM_PROJECT',
  'VENDOR_REFERENCE', 'EVALUATION_BOARD', 'MODULE',
  'KICAD_PROJECT', 'ALTIUM_PROJECT', 'PDF_SCHEMATIC', 'DATASHEET_APPLICATION',
  'GITHUB', 'TINDIE', 'SEEED', 'HACKSTER', 'HACKADAY', 'OTHER_PUBLIC',
] as const;
export type ReferenceDesignSourceType = (typeof REFERENCE_DESIGN_SOURCE_TYPES)[number];

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

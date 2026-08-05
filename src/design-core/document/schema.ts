/**
 * design-core/document/schema.ts
 * 运行时 Schema 校验 (Zod) + 版本迁移入口。
 * 保证导入/加载的文档结构正确，旧版本可迁移。
 */
import { z } from 'zod';
import { SCHEMA_VERSION } from './types';
import type { CircuitCanvasDocument } from './types';

const pointSchema = z.object({ x: z.number(), y: z.number() });

const footprintGeometrySchema = z.object({
  footprintId: z.string(),
  bodyWidthMm: z.number().positive(),
  bodyHeightMm: z.number().positive(),
  courtyardWidthMm: z.number().positive(),
  courtyardHeightMm: z.number().positive(),
  assemblyHeightMm: z.number().optional(),
  padCount: z.number().int().nonnegative(),
  rotationStep: z.number().positive(),
  anchor: pointSchema,
});

const moneySchema = z.object({ amount: z.number(), currency: z.string() });

const placedComponentSchema = z.object({
  instanceId: z.string(),
  componentId: z.string(),
  mpn: z.string(),
  reference: z.string(),
  category: z.enum(['mcu', 'power', 'passive', 'connector', 'ic']),
  manufacturer: z.string(),
  footprint: z.object({
    footprintId: z.string(),
    name: z.string(),
    geometry: footprintGeometrySchema,
    confidence: z.number().optional(),
  }),
  placement: z.object({
    xMm: z.number(),
    yMm: z.number(),
    rotation: z.number(),
    side: z.enum(['TOP', 'BOTTOM']),
    locked: z.boolean(),
  }),
  functionalBlockId: z.string().optional(),
  quantity: z.number().int().positive(),
  unitPrice: moneySchema.optional(),
  source: z.enum(['EZPLM', 'LOCAL', 'CUSTOM', 'MOCK']),
  refDesDisplay: z.object({ dx: z.number(), dy: z.number(), rotation: z.number(), hidden: z.boolean() }).optional(),
  customSymbolSvg: z.string().optional(),
  display: z
    .object({
      description: z.string().optional(),
      family: z.string().optional(),
      attributes: z.record(z.string()).optional(),
      pins: z.number().optional(),
      datasheetUrl: z.string().optional(),
      imageUrl: z.string().optional(),
      stepUrl: z.string().optional(),
      footprintFileUrl: z.string().optional(),
      symbolFileUrl: z.string().optional(),
      classification: z.string().optional(),
    })
    .optional(),
});

const boardSchema = z.object({
  id: z.string(),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  shape: z.enum(['rect', 'rounded', 'circle', 'lshape', 'polygon']),
  outline: z.array(pointSchema).optional(),
  mountingHoles: z.array(z.object({ position: pointSchema, diameterMm: z.number() })),
  keepoutZones: z.array(z.object({ id: z.string(), label: z.string(), polygon: z.array(pointSchema) })),
  placementZones: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      category: z.enum(['mcu', 'power', 'passive', 'connector', 'ic']).optional(),
      normRect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    })
  ),
  layerCount: z.number().int().optional(),
  mountingHolesEnabled: z.boolean().optional(),
});

const connectionSchema = z.object({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  label: z.string(),
  style: z.enum(['single', 'double', 'none', 'bus']),
  color: z.string().optional(),
  labelDx: z.number().optional(),
  labelDy: z.number().optional(),
  labelRot: z.number().optional(),
});

const functionalBlockSchema = z.object({
  id: z.string(),
  label: z.string(),
  sublabel: z.string().optional(),
  shape: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  color: z.string(),
  componentIds: z.array(z.string()).optional(),
});

const bomLineSchema = z.object({
  reference: z.string(),
  mpn: z.string(),
  manufacturer: z.string(),
  footprint: z.string(),
  quantity: z.number(),
  unitPrice: moneySchema.optional(),
  description: z.string().optional(),
});

const reviewFindingSchema = z.object({
  id: z.string(),
  level: z.enum(['high', 'mid', 'low', 'info']),
  title: z.string(),
  detail: z.string().optional(),
  category: z.enum(['completeness', 'placement', 'thermal', 'emc', 'sourcing', 'mechanical']),
});

export const documentSchema = z.object({
  schemaVersion: z.string(),
  id: z.string(),
  name: z.string(),
  context: z.object({
    tenantId: z.string().optional(),
    organizationId: z.string().optional(),
    workspaceId: z.string().optional(),
    projectId: z.string().optional(),
    source: z.enum(['demo', 'standalone', 'integrated']),
  }),
  designIntent: z.object({ requirement: z.string(), rationale: z.string(), generatedAt: z.string() }).optional(),
  board: boardSchema,
  components: z.array(placedComponentSchema),
  functionalBlocks: z.array(functionalBlockSchema),
  connections: z.array(connectionSchema),
  bom: z.array(bomLineSchema),
  reviewResults: z.array(reviewFindingSchema),
  metadata: z.object({
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    revision: z.number().int(),
  }),
});

export type ValidationResult =
  | { ok: true; document: CircuitCanvasDocument }
  | { ok: false; error: string };

/**
 * 校验并迁移文档。未来 schema 升级时在此加入版本迁移分支。
 */
export function parseDocument(raw: unknown): ValidationResult {
  const migrated = migrate(raw);
  const result = documentSchema.safeParse(migrated);
  if (result.success) {
    return { ok: true, document: result.data as CircuitCanvasDocument };
  }
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

/** 版本迁移：把旧 schemaVersion 的文档升级到当前结构。 */
function migrate(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const doc = raw as Record<string, unknown>;
  const version = typeof doc.schemaVersion === 'string' ? doc.schemaVersion : '0.0.0';
  // 示例：从无版本/旧版本迁移
  if (version === SCHEMA_VERSION) return doc;
  // 这里集中处理逐版本迁移；当前仅打平版本号
  return { ...doc, schemaVersion: SCHEMA_VERSION };
}

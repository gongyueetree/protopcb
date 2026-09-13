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
  category: z.enum(['mcu', 'power', 'passive', 'connector', 'ic', 'electromech', 'sensor', 'rf']),
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
  trust: z.object({
    level: z.enum(['VERIFIED', 'CANDIDATE', 'PLACEHOLDER']),
    evidence: z.string(),
    verifiedAt: z.string().optional(),
    source: z.string().optional(),
  }).optional(),
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
      anchorRef: z.string().optional(),
      padNets: z.record(z.number()).optional(),
      zOffsetMm: z.number().optional(),
      officialUrl: z.string().optional(),
      footprintFileUrl: z.string().optional(),
      symbolFileUrl: z.string().optional(),
      symbolFromMpn: z.string().optional(),
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
      category: z.enum(['mcu', 'power', 'passive', 'connector', 'ic', 'electromech', 'sensor', 'rf']).optional(),
      normRect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    })
  ),
  layerCount: z.number().int().optional(),
  mountingHolesEnabled: z.boolean().optional(),
  cutWidthMm: z.number().optional(),
  cutHeightMm: z.number().optional(),
  cornerRadiusMm: z.number().optional(),
});

const connectionSchema = z.object({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  label: z.string(),
  style: z.enum(['single', 'double', 'back', 'none', 'bus']),
  dir: z.enum(['forward', 'back', 'both', 'none']).optional(),
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
  /** 导入工程的电气网络表（网络号 → 网络名），导出 PCB 时写回 */
  nets: z.record(z.string()).optional(),
  // layer 用 string：'top'/'bottom' 别名 + 内层 KiCad 原名（In1.Cu…）；net 为源文件网络号
  tracks: z.array(z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), w: z.number(), layer: z.string(), net: z.number().int().optional() })).optional(),
  vias: z.array(z.object({
    x: z.number(), y: z.number(), size: z.number(),
    drill: z.number().positive().optional(),
    net: z.number().int().optional(),
    layers: z.tuple([z.string(), z.string()]).optional(),
    viaType: z.enum(['blind', 'micro']).optional(),
  })).optional(),
  /** 导入工程的铜层栈（KiCad 层名，按栈顺序） */
  copperLayers: z.array(z.string()).optional(),
  enclosure: z.object({
    enabled: z.boolean(),
    wallMm: z.number().finite().positive().max(20),
    sideClearanceMm: z.number().finite().min(0).max(50),
    standoffMm: z.number().finite().min(0).max(60),
    topClearanceMm: z.number().finite().min(0).max(60),
    bottomClearanceMm: z.number().finite().min(0).max(60),
    lidMm: z.number().finite().positive().max(20),
  }).optional(),
  /** KiCad 工程导入的原理图原样视图（只读渲染：实例坐标/连线/结点/标签） */
  schematicSheet: z.object({
    instances: z.array(z.object({
      ref: z.string(), libId: z.string(), value: z.string().optional(),
      x: z.number(), y: z.number(), rot: z.number(),
      mirror: z.string().optional(), unit: z.number().optional(),
      mat: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
      refPos: z.object({ x: z.number(), y: z.number(), rot: z.number(), hidden: z.boolean(), sizeMm: z.number().optional(), anchor: z.enum(['start', 'middle', 'end']).optional() }).optional(),
      valPos: z.object({ x: z.number(), y: z.number(), rot: z.number(), hidden: z.boolean(), sizeMm: z.number().optional(), anchor: z.enum(['start', 'middle', 'end']).optional() }).optional(),
    })),
    wires: z.array(z.array(z.tuple([z.number(), z.number()]))),
    buses: z.array(z.array(z.tuple([z.number(), z.number()]))).optional(),
    busEntries: z.array(z.array(z.tuple([z.number(), z.number()]))).optional(),
    junctions: z.array(z.tuple([z.number(), z.number()])),
    labels: z.array(z.object({ text: z.string(), x: z.number(), y: z.number(), rot: z.number() })),
    noConnects: z.array(z.tuple([z.number(), z.number()])),
    /** libId → 符号定义原文（渲染用原始几何） */
    libSymbols: z.record(z.string()),
    legacySymbols: z.record(z.object({
      rects: z.array(z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })),
      polys: z.array(z.array(z.object({ x: z.number(), y: z.number() }))),
      circles: z.array(z.object({ cx: z.number(), cy: z.number(), r: z.number() })),
      arcs: z.array(z.object({ x1: z.number(), y1: z.number(), xm: z.number(), ym: z.number(), x2: z.number(), y2: z.number() })),
      pins: z.array(z.object({ x: z.number(), y: z.number(), ex: z.number(), ey: z.number(), number: z.string(), name: z.string() })),
    })).optional(),
    frame: z.object({ wMm: z.number(), hMm: z.number(), title: z.string().optional(), date: z.string().optional(), rev: z.string().optional(), company: z.string().optional(), comments: z.array(z.string()).optional() }).optional(),
  }).optional(),
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

/* ---------- 显式版本迁移链 ---------- */

type RawDoc = Record<string, unknown>;

/**
 * 每个迁移是 from → to 的纯函数，只做该版本跨度内的结构变换。
 * 旧实现"遇到旧文件只把 schemaVersion 改成最新"不是迁移 —— 结构差异会
 * 原样落到 Zod 校验里以难懂的报错失败。现在逐版本升级、每步可单测。
 */
interface Migration { from: string; to: string; up: (doc: RawDoc) => RawDoc }

export const MIGRATIONS: Migration[] = [
  {
    // 无版本 / 早期原型：补齐必备容器字段与 metadata（缺失时给空缺省）
    from: '0.0.0', to: '1.0.0',
    up: (doc) => ({
      components: [], functionalBlocks: [], connections: [], bom: [], reviewResults: [],
      ...doc,
      metadata: (doc.metadata as RawDoc) ?? { createdBy: 'unknown', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), revision: 1 },
      context: (doc.context as RawDoc) ?? { source: 'demo' },
    }),
  },
  {
    // 1.x → 2.0：board.mountingHoles 从 {x,y,d} 迁移为 {position:{x,y},diameterMm}
    from: '1.0.0', to: '2.0.0',
    up: (doc) => {
      const board = { ...(doc.board as RawDoc ?? {}) };
      const holes = board.mountingHoles;
      if (Array.isArray(holes)) {
        board.mountingHoles = holes.map((h) => {
          const hh = h as RawDoc;
          if (hh.position) return hh;
          return { position: { x: Number(hh.x) || 0, y: Number(hh.y) || 0 }, diameterMm: Number(hh.d ?? hh.diameterMm) || 3.2 };
        });
      }
      return { ...doc, board };
    },
  },
  {
    // 2.x → 3.0：track.layer 归一（'F.Cu'/'B.Cu' 字面量 → 'top'/'bottom' 画布别名，内层保留原名）
    from: '2.0.0', to: '3.0.0',
    up: (doc) => {
      const tracks = Array.isArray(doc.tracks)
        ? (doc.tracks as RawDoc[]).map((t) => ({
            ...t,
            layer: t.layer === 'F.Cu' ? 'top' : t.layer === 'B.Cu' ? 'bottom' : (t.layer ?? 'top'),
          }))
        : doc.tracks;
      return { ...doc, tracks };
    },
  },
];

/** 版本比较（semver 主.次.补，缺段按 0） */
function verCmp(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0); }
  return 0;
}

/** 逐版本执行迁移链（导出以便单测）。未知的更高版本原样返回交给 Zod 报错。 */
export function migrateDocument(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  let doc = { ...(raw as RawDoc) };
  let version = typeof doc.schemaVersion === 'string' ? doc.schemaVersion : '0.0.0';
  for (const m of MIGRATIONS) {
    if (verCmp(version, m.from) <= 0 && verCmp(m.to, version) > 0) {
      doc = m.up(doc);
      version = m.to;
    }
  }
  return { ...doc, schemaVersion: SCHEMA_VERSION };
}

function migrate(raw: unknown): unknown {
  return migrateDocument(raw);
}

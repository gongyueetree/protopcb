/**
 * design-core/document/schema.ts
 * 运行时 Schema 校验 (Zod) + 版本迁移入口。
 * 保证导入/加载的文档结构正确，旧版本可迁移。
 */
import { z } from 'zod';

/** 板级尺寸的合理上界（mm）：挡住畸形/篡改数据撑爆画布与 3D 场景 */
const mmCoord = z.number().finite().min(-10000).max(10000);
const mmPositive = z.number().finite().positive().max(10000);
import { RUN_MODES, COMPONENT_CATEGORIES, COMPONENT_SOURCES, TRUST_LEVELS, BOARD_SIDES, BOARD_SHAPES, CONNECTION_STYLES, CONNECTION_DIRS, REVIEW_LEVELS, REVIEW_CATEGORIES, LABEL_KINDS, TEXT_ANCHORS, VIA_TYPES } from './enums';
import { SCHEMA_VERSION } from './enums';
// CircuitCanvasDocument 由本文件的 documentSchema 推导，这里直接用 z.infer，避免与 types.ts 互相 import
type CircuitCanvasDocument = z.infer<typeof documentSchema>;

export const pointSchema = z.object({ x: z.number(), y: z.number() });

export const footprintGeometrySchema = z.object({
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

export const moneySchema = z.object({ amount: z.number(), currency: z.string() });

export const placedComponentSchema = z.object({
  instanceId: z.string(),
  componentId: z.string(),
  mpn: z.string(),
  reference: z.string(),
  category: z.enum(COMPONENT_CATEGORIES),
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
    side: z.enum(BOARD_SIDES),
    locked: z.boolean(),
  }),
  functionalBlockId: z.string().optional(),
  quantity: z.number().int().positive(),
  unitPrice: moneySchema.optional(),
  source: z.enum(COMPONENT_SOURCES),
  refDesDisplay: z.object({ dx: z.number(), dy: z.number(), rotation: z.number(), hidden: z.boolean() }).optional(),
  trust: z.object({
    level: z.enum(TRUST_LEVELS),
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
      sessionModelLost: z.boolean().optional(),
      anchorRef: z.string().optional(),
      padNets: z.record(z.number()).optional(),
      zOffsetMm: z.number().optional(),
      /** 3D 模型的摆正变换（来自 .kicad_pcb 的 (model) 节点：offset mm / rotate deg / scale） */
      modelTransform: z.object({
        offset: z.tuple([z.number(), z.number(), z.number()]).optional(),
        rotate: z.tuple([z.number(), z.number(), z.number()]).optional(),
        scale: z.tuple([z.number(), z.number(), z.number()]).optional(),
      }).optional(),
      officialUrl: z.string().optional(),
      footprintFileUrl: z.string().optional(),
      symbolFileUrl: z.string().optional(),
      symbolFromMpn: z.string().optional(),
      classification: z.string().optional(),
    })
    .optional(),
});

export const boardSchema = z.object({
  id: z.string(),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  shape: z.enum(BOARD_SHAPES),
  outline: z.array(pointSchema).optional(),
  mountingHoles: z.array(z.object({ position: pointSchema, diameterMm: z.number() })),
  keepoutZones: z.array(z.object({ id: z.string(), label: z.string(), polygon: z.array(pointSchema) })),
  placementZones: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      category: z.enum(COMPONENT_CATEGORIES).optional(),
      normRect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    })
  ),
  layerCount: z.number().int().optional(),
  mountingHolesEnabled: z.boolean().optional(),
  cutWidthMm: z.number().optional(),
  cutHeightMm: z.number().optional(),
  cornerRadiusMm: z.number().optional(),
});

export const connectionSchema = z.object({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  label: z.string(),
  style: z.enum(CONNECTION_STYLES),
  dir: z.enum(CONNECTION_DIRS).optional(),
  color: z.string().optional(),
  labelDx: z.number().optional(),
  labelDy: z.number().optional(),
  labelRot: z.number().optional(),
});

export const functionalBlockSchema = z.object({
  /** 由生成器产出（按类别 / 按连接关系）；用户手动添加的块没有这个标记，重新生成时保留 */
  generated: z.enum(['category', 'netlist']).optional(),
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

export const bomLineSchema = z.object({
  reference: z.string(),
  mpn: z.string(),
  manufacturer: z.string(),
  footprint: z.string(),
  quantity: z.number(),
  unitPrice: moneySchema.optional(),
  description: z.string().optional(),
});

export const reviewFindingSchema = z.object({
  id: z.string(),
  level: z.enum(REVIEW_LEVELS),
  title: z.string(),
  detail: z.string().optional(),
  category: z.enum(REVIEW_CATEGORIES),
});

/** 单页原理图（原样视图） */
export const SchematicSheetSchema = z.object({
    instances: z.array(z.object({
      ref: z.string(), libId: z.string(), value: z.string().optional(),
      x: z.number(), y: z.number(), rot: z.number(),
      mirror: z.string().optional(), unit: z.number().optional(),
      mat: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
      refPos: z.object({ x: z.number(), y: z.number(), rot: z.number(), hidden: z.boolean(), sizeMm: z.number().optional(), anchor: z.enum(TEXT_ANCHORS).optional() }).optional(),
      valPos: z.object({ x: z.number(), y: z.number(), rot: z.number(), hidden: z.boolean(), sizeMm: z.number().optional(), anchor: z.enum(TEXT_ANCHORS).optional() }).optional(),
    })),
    wires: z.array(z.array(z.tuple([z.number(), z.number()]))),
    buses: z.array(z.array(z.tuple([z.number(), z.number()]))).optional(),
    busEntries: z.array(z.array(z.tuple([z.number(), z.number()]))).optional(),
    junctions: z.array(z.tuple([z.number(), z.number()])),
    labels: z.array(z.object({ text: z.string(), x: z.number(), y: z.number(), rot: z.number(), kind: z.enum(LABEL_KINDS).optional(), shape: z.string().optional() })),
    sheets: z.array(z.object({
      name: z.string(), file: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(),
      pins: z.array(z.object({ name: z.string(), x: z.number(), y: z.number(), rot: z.number(), shape: z.string().optional() })),
    })).optional(),
    file: z.string().optional(),
    name: z.string().optional(),
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
    source: z.enum(RUN_MODES),
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
    viaType: z.enum(VIA_TYPES).optional(),
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
  /** KiCad 工程导入的原理图原样视图：全部页面按文件名索引；当前页是 UI 状态，不在文档里 */
  /**
   * 导入工程内嵌的真实焊盘表（封装名 → 焊盘定义）。
   * 必须随文档持久化：它是 2D 绘制、3D 建模、KiCad 回写的共同依据。
   * 此前只注册在内存里，刷新后恢复的存档会回落到"按名字猜"的几何 —— 器件 2D/3D 全不对。
   * 体积可控：真实工程约 20 个唯一封装、16–19KB。
   */
  importedFootprints: z.record(
    z.string().max(200),
    z.object({
      // 尺寸有上界：异常工程/篡改过的 JSON 不该能撑爆 2D 画布与 3D 场景
      bodyW: mmPositive, bodyH: mmPositive,
      bodyCx: mmCoord.optional(), bodyCy: mmCoord.optional(),
      heightMm: mmPositive.optional(),
      approximate: z.boolean().optional(),
      pin1: z.object({ x: mmCoord, y: mmCoord }).optional(),
      pads: z.array(z.object({
        x: mmCoord, y: mmCoord, w: mmPositive, h: mmPositive,
        num: z.union([z.string().max(16), z.number()]),
        round: z.boolean().optional(),
      })).max(5000),                       // BGA 上千球已是极端，5000 足够且挡得住畸形数据
    }),
  ).refine((r) => Object.keys(r).length <= 2000, { message: '封装定义数量超出上限（2000）' }).optional(),
  schematicSheets: z.record(z.string(), SchematicSheetSchema).optional(),
  rootSheetFile: z.string().optional(),
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

/**
 * ⚠ 顺序必须按版本严格升序：migrateDocument 顺序遍历，
 * 一旦先执行了跨度更大的那一步，版本号会被抬高，中间的迁移就被整段跳过。
 * （实测踩过：把 3.0→3.1 放在 2.0→3.0 前面，导致 v2 文档的 track.layer 没被归一。）
 */
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
  {
    // 3.0 → 3.1：enabled=true 但 mountingHoles=[] 的旧文档补成真实孔位，
    // 消除"开关为真但没有孔"的中间态（各模块曾各自推算四角，结果互不一致）
    from: '3.0.0', to: '3.1.0',
    up: (doc) => {
      const board = { ...(doc.board as RawDoc ?? {}) };
      if (board.mountingHolesEnabled === true && !(Array.isArray(board.mountingHoles) && board.mountingHoles.length)) {
        const W = Number(board.widthMm) || 100, H = Number(board.heightMm) || 80, m = 4, d = 3.2;
        board.mountingHoles = board.shape === 'circle' ? [] : [
          { position: { x: m, y: m }, diameterMm: d },
          { position: { x: W - m, y: m }, diameterMm: d },
          { position: { x: m, y: H - m }, diameterMm: d },
          { position: { x: W - m, y: H - m }, diameterMm: d },
        ];
      }
      return { ...doc, board };
    },
  },
  {
    // 3.1 → 3.2：文档里不再复制"当前页"（schematicSheet）。旧文档若只有单页对象，
    // 折成 schematicSheets[file] + rootSheetFile；若两者都有，以 schematicSheets 为准。
    from: '3.1.0', to: '3.2.0',
    up: (doc) => {
      const d = { ...doc } as RawDoc;
      const single = d.schematicSheet as RawDoc | undefined;
      const sheets = (d.schematicSheets as Record<string, RawDoc> | undefined) ?? undefined;
      if (single && !(sheets && Object.keys(sheets).length)) {
        const file = String(single.file ?? d.rootSheetFile ?? 'schematic.kicad_sch');
        d.schematicSheets = { [file]: { ...single, file } };
        d.rootSheetFile = file;
      }
      delete d.schematicSheet;
      return d;
    },
  },
  {
    // 3.2 → 3.3：新增 document.importedFootprints（导入工程的内嵌焊盘表）。
    // 纯 additive 可选字段，无需搬数据；仍单独记一版，保持 schema 演进可追溯。
    from: '3.2.0', to: '3.3.0',
    up: (doc) => doc,
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

/**
 * design-core/document/types.ts
 * 统一设计文档模型 (CircuitCanvasDocument)。
 * 这是本地保存、后端存储、ezPLM 附件、版本比较、AI 输入、KiCad 导出的统一格式。
 */
import type { FootprintGeometry, BoardSide, Polygon, Point } from '../geometry/types';

export const SCHEMA_VERSION = '3.1.0';

export type RunMode = 'demo' | 'standalone' | 'integrated';
export type ComponentCategory = 'mcu' | 'power' | 'passive' | 'connector' | 'ic' | 'electromech' | 'sensor' | 'rf';
export type ComponentSource = 'EZPLM' | 'LOCAL' | 'CUSTOM' | 'MOCK';

export interface Money {
  amount: number;
  currency: string; // 'CNY' | 'USD' ...
}

/* ---------- 板框 ---------- */
export type BoardShapeKind = 'rect' | 'rounded' | 'circle' | 'lshape' | 'polygon';

export interface MountingHole {
  position: Point;
  diameterMm: number;
}

export interface PlacementZone {
  id: string;
  label: string;
  category?: ComponentCategory;
  /** 相对板框的归一化矩形 [x0,y0,x1,y1] (0..1) */
  normRect: [number, number, number, number];
}

export interface KeepoutZone {
  id: string;
  label: string;
  polygon: Polygon;
}

export interface BoardDefinition {
  id: string;
  widthMm: number;
  heightMm: number;
  shape: BoardShapeKind;
  outline?: Polygon; // polygon/lshape 时使用
  mountingHoles: MountingHole[];
  keepoutZones: KeepoutZone[];
  placementZones: PlacementZone[];
  layerCount?: number;
  /** 是否启用四角定位孔 */
  mountingHolesEnabled?: boolean;
  /** L 形切角尺寸（mm，缺省 45%W / 40%H）与凸角圆角半径（mm，缺省 0 直角） */
  cutWidthMm?: number;
  cutHeightMm?: number;
  cornerRadiusMm?: number;
}

/* ---------- 已放置器件 ---------- */
export interface PlacedComponent {
  instanceId: string;
  componentId: string;
  mpn: string;
  reference: string; // 位号 U1/C1/J1
  category: ComponentCategory;
  manufacturer: string;

  footprint: {
    footprintId: string;
    name: string;
    geometry: FootprintGeometry;
    confidence?: number;
  };

  placement: {
    xMm: number;
    yMm: number;
    rotation: number;
    side: BoardSide;
    locked: boolean;
  };

  functionalBlockId?: string;
  quantity: number;
  unitPrice?: Money;
  source: ComponentSource;

  /**
   * 型号可信等级：数据事实与模型猜测必须可区分。
   *  VERIFIED    数据库/分销商精确命中
   *  CANDIDATE   仅近似匹配，需人工确认
   *  PLACEHOLDER 模型建议，数据库未收录
   * 缺省视为 PLACEHOLDER（保守）。
   */
  trust?: {
    level: 'VERIFIED' | 'CANDIDATE' | 'PLACEHOLDER';
    evidence: string;
    verifiedAt?: string;
    source?: string;
  };
  /** 位号显示状态（可移动/旋转/隐藏） */
  refDesDisplay?: { dx: number; dy: number; rotation: number; hidden: boolean };
  /** 用户上传的自定义原理图符号（SVG 文本，封装占位器件用） */
  customSymbolSvg?: string;

  /** 透传的展示属性（描述、关键参数等），不参与几何计算 */
  display?: {
    description?: string;
    family?: string;
    attributes?: Record<string, string>;
    pins?: number;
    /** ezPLM 实时物料附带：Datasheet PDF / 器件图片链接 */
    datasheetUrl?: string;
    imageUrl?: string;
    stepUrl?: string;
    /** 辅件归属的核心器件位号（自动布局锚定用） */
    anchorRef?: string;
    /** 焊盘号 → 网络号（导入工程带来，导出时写回） */
    padNets?: Record<string, number>;
    /** 3D 视图中的高度偏移（mm，托高/压低模型，不影响 2D） */
    zOffsetMm?: number;
    officialUrl?: string;
    footprintFileUrl?: string;
    symbolFileUrl?: string;
    /** 仅关联符号时：符号来自库中哪个型号（符号覆盖表按此 key 查） */
    symbolFromMpn?: string;
    classification?: string;
  };
}

/* ---------- 功能块 / 框图 ---------- */
export interface FunctionalBlock {
  id: string;
  label: string;
  sublabel?: string;
  shape: string; // rect | rounded | diamond | circle | hexagon | ...
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  componentIds?: string[]; // 关联的器件 instanceId
}

export type ConnectionStyle = 'single' | 'double' | 'back' | 'none' | 'bus';

export interface LogicalConnection {
  id: string;
  fromId: string; // FunctionalBlock.id 或 PlacedComponent.instanceId
  toId: string;
  label: string;
  style: ConnectionStyle;
  /** 箭头方向（与线型解耦，总线也可设方向）；缺省从 style 推断保持兼容 */
  dir?: 'forward' | 'back' | 'both' | 'none';
  color?: string;
  /** 标签显示偏移与旋转（可拖动/旋转） */
  labelDx?: number;
  labelDy?: number;
  labelRot?: number;
}

/* ---------- BOM ---------- */
export interface BomLine {
  reference: string;
  mpn: string;
  manufacturer: string;
  footprint: string;
  quantity: number;
  unitPrice?: Money;
  description?: string;
}

/* ---------- 设计审查 ---------- */
export type ReviewLevel = 'high' | 'mid' | 'low' | 'info';

export interface ReviewFinding {
  id: string;
  level: ReviewLevel;
  title: string;
  detail?: string;
  category: 'completeness' | 'placement' | 'thermal' | 'emc' | 'sourcing' | 'mechanical';
}

/* ---------- 顶层文档 ---------- */
export interface CircuitCanvasDocument {
  /**
   * 导入工程的铜箔走线（真实线宽 mm，坐标相对板左上角）。
   * layer：'top'/'bottom' 为画布常用别名（=F.Cu/B.Cu）；内层保留 KiCad 原名（In1.Cu…），
   * 导出时原样写回，绝不把内层压成 F.Cu。
   * net：源文件网络号；导出写回（此前丢失 → 全部变 net 0，电气信息尽毁）。
   */
  tracks?: { x1: number; y1: number; x2: number; y2: number; w: number; layer: string; net?: number }[];
  /**
   * 导入工程的过孔：size=外径；drill/net/layers/viaType 均来自源文件原值。
   * 禁止导出时用 size*0.5 之类重新猜测 drill。
   */
  vias?: { x: number; y: number; size: number; drill?: number; net?: number; layers?: [string, string]; viaType?: 'blind' | 'micro' }[];
  /** 外壳协同设计参数（参数化包络 + 确定性干涉检查；见 design-core/enclosure） */
  enclosure?: {
    enabled: boolean; wallMm: number; sideClearanceMm: number; standoffMm: number;
    topClearanceMm: number; bottomClearanceMm: number; lidMm: number;
  };
  /**
   * 导入工程的铜层栈（KiCad 层名，按栈顺序，如 ["F.Cu","In1.Cu","In2.Cu","B.Cu"]）。
   * 未导入/新建设计时缺省视为双层 F.Cu/B.Cu。导出层表按此生成。
   */
  copperLayers?: string[];
  /** 导入工程的电气网络表（网络号 → 网络名） */
  nets?: Record<string, string>;
  /** KiCad 工程导入的原理图原样视图（只读） */
  schematicSheet?: {
    instances: {
      ref: string; libId: string; value?: string;
      x: number; y: number; rot: number; mirror?: string; unit?: number;
      mat?: [number, number, number, number];
      refPos?: { x: number; y: number; rot: number; hidden: boolean; sizeMm?: number; anchor?: 'start' | 'middle' | 'end' };
      valPos?: { x: number; y: number; rot: number; hidden: boolean; sizeMm?: number; anchor?: 'start' | 'middle' | 'end' };
    }[];
    wires: [number, number][][];
    buses?: [number, number][][];
    busEntries?: [number, number][][];
    junctions: [number, number][];
    labels: { text: string; x: number; y: number; rot: number }[];
    noConnects: [number, number][];
    libSymbols: Record<string, string>;
    /** KiCad 5 旧库符号几何（.lib 解析结果；新格式走 libSymbols 文本） */
    legacySymbols?: Record<string, {
      rects: { x1: number; y1: number; x2: number; y2: number }[];
      polys: { x: number; y: number }[][];
      circles: { cx: number; cy: number; r: number }[];
      arcs: { x1: number; y1: number; xm: number; ym: number; x2: number; y2: number }[];
      pins: { x: number; y: number; ex: number; ey: number; number: string; name: string }[];
    }>;
    /** 图框与标题栏（旧版工程 $Descr） */
    frame?: { wMm: number; hMm: number; title?: string; date?: string; rev?: string; company?: string; comments?: string[] };
  };
  schemaVersion: string;
  id: string;
  name: string;

  context: {
    tenantId?: string;
    organizationId?: string;
    workspaceId?: string;
    projectId?: string;
    source: RunMode;
  };

  /** 方案设计意图（AI 生成时记录：需求原文 + 选型理由） */
  designIntent?: { requirement: string; rationale: string; generatedAt: string };

  board: BoardDefinition;
  components: PlacedComponent[];
  functionalBlocks: FunctionalBlock[];
  connections: LogicalConnection[];
  bom: BomLine[];
  reviewResults: ReviewFinding[];

  metadata: {
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    revision: number;
  };
}

/**
 * design-core/enclosure/index.ts
 * 外壳协同设计 —— 纯几何、确定性计算，不含任何 LLM 推理。
 *
 * 定位（诚实边界）：
 *   本模块做的是**参数化外壳包络 + 干涉检查**：由 PCB 外形、器件高度包络、
 *   壁厚/间隙/支柱等参数推出外壳内外尺寸，并逐项检查 PCB 与外壳是否干涉。
 *   它不是结构设计软件：不做圆角过渡、拔模、卡扣、加强筋、螺纹孔与强度分析，
 *   导出的也不是可直接注塑的模型。适合做原型阶段的尺寸协同与 3D 打印初版。
 *
 * 器件高度来源优先级（与 3D 渲染共用同一真值，避免两处各算一套）：
 *   1. datasheet 机械图提取的真实高度（PadFootprint.heightMm，定制器件向导写入）
 *   2. 按封装族 + 本体尺寸的启发式估计（标记为 estimated，检查结论会注明）
 *   用户设置的 zOffsetMm（架高）计入总高。
 */
import type { CircuitCanvasDocument, BoardDefinition, PlacedComponent } from '../document/types';
import { padFootprintFor } from '../geometry/footprint-pads';
import { effectiveMountingHoles } from '../board/mounting-holes';

export interface EnclosureSpec {
  /** 是否启用外壳协同（3D 视图叠加显示） */
  enabled: boolean;
  /** 壁厚 mm */
  wallMm: number;
  /** PCB 边缘到外壳内壁的水平间隙 mm */
  sideClearanceMm: number;
  /** PCB 底面到外壳内底的距离（铜柱/支柱高度）mm */
  standoffMm: number;
  /** 顶面器件最高点到外壳内顶的净空 mm */
  topClearanceMm: number;
  /** 底面器件最低点到外壳内底的净空 mm（PCB 翻面器件用） */
  bottomClearanceMm: number;
  /** 顶盖厚度 mm */
  lidMm: number;
}

export const DEFAULT_ENCLOSURE: EnclosureSpec = {
  enabled: false,
  wallMm: 2.0,
  sideClearanceMm: 1.5,
  standoffMm: 4.0,
  topClearanceMm: 2.0,
  bottomClearanceMm: 1.0,
  lidMm: 2.0,
};

export const PCB_THICKNESS_MM = 1.6;

/* ---------- 器件高度 ---------- */

export interface ComponentHeight {
  /** 本体高度 mm（不含 zOffset） */
  bodyMm: number;
  /** true = 来自 datasheet 机械图；false = 按封装族估算 */
  fromDatasheet: boolean;
}

/**
 * 单个器件的本体高度。3D 参数化模型与外壳检查共用此函数 —— 单一真值来源。
 * 估算规则来自封装族惯例，属于**近似**：结论中必须标注，不能当作工程事实。
 */
export function componentBodyHeight(footprintName: string): ComponentHeight {
  const fp = padFootprintFor(footprintName);
  if (fp?.heightMm && fp.heightMm > 0) return { bodyMm: Math.min(fp.heightMm, 40), fromDatasheet: true };
  const N = (footprintName || '').toUpperCase();
  const minDim = fp ? Math.min(fp.bodyW, fp.bodyH) : 3;
  const isBall = !!fp && fp.pads.length > 0 && fp.pads.every((p) => p.round) && /(WLCSP|BGA|CSP)/.test(N);
  const hasTht = !!fp && fp.pads.some((pd) => pd.round && pd.w >= 1.2);
  const bodyMm = isBall ? 0.6
    : /(QFN|DFN|SON)/.test(N) ? 0.9
    : /(SOIC|SOP|SSOP|TSSOP|SOT|QFP)/.test(N) ? 1.6
    : /(MODULE|FEATHER|ESP|BOARD|SHIELD)/.test(N) ? 3.2
    : /(CRYSTAL|OSC|XTAL)/.test(N) ? Math.min(minDim * 0.8, 13.5)
    : /(POT|SWITCH|BUTTON|RELAY|CONN|SOCKET|HEADER|USB)/.test(N) ? Math.min(Math.max(minDim * 0.6, 3), 12)
    : Math.min(Math.max(minDim * (hasTht ? 0.5 : 0.3), 1.2), 10);
  return { bodyMm, fromDatasheet: false };
}

/** 器件占用的总高度（含用户架高 zOffsetMm） */
export function componentTotalHeight(c: PlacedComponent): ComponentHeight {
  const h = componentBodyHeight(c.footprint.name);
  return { bodyMm: h.bodyMm + Math.max(0, c.display?.zOffsetMm ?? 0), fromDatasheet: h.fromDatasheet };
}

export interface HeightEnvelope {
  /** 顶面最高器件高度 mm */
  topMaxMm: number;
  /** 底面最高器件高度 mm */
  bottomMaxMm: number;
  topTallest?: { reference: string; mpn: string; heightMm: number; fromDatasheet: boolean };
  bottomTallest?: { reference: string; mpn: string; heightMm: number; fromDatasheet: boolean };
  /** 有多少器件的高度是估算而非 datasheet 实测 */
  estimatedCount: number;
}

export function heightEnvelope(components: PlacedComponent[]): HeightEnvelope {
  const env: HeightEnvelope = { topMaxMm: 0, bottomMaxMm: 0, estimatedCount: 0 };
  for (const c of components) {
    const h = componentTotalHeight(c);
    if (!h.fromDatasheet) env.estimatedCount++;
    const rec = { reference: c.reference, mpn: c.mpn, heightMm: h.bodyMm, fromDatasheet: h.fromDatasheet };
    if (c.placement.side === 'BOTTOM') {
      if (h.bodyMm > env.bottomMaxMm) { env.bottomMaxMm = h.bodyMm; env.bottomTallest = rec; }
    } else if (h.bodyMm > env.topMaxMm) { env.topMaxMm = h.bodyMm; env.topTallest = rec; }
  }
  return env;
}

/* ---------- 外壳尺寸 ---------- */

export interface EnclosureDims {
  /** 内腔尺寸（容纳 PCB 的净空间） */
  innerW: number; innerH: number; innerDepth: number;
  /** 外形尺寸 */
  outerW: number; outerH: number; outerHeight: number;
  /** PCB 底面相对内腔底面的高度 = standoff */
  pcbBottomY: number;
}

/** 由 PCB 与器件高度包络推出外壳尺寸（纯函数） */
export function computeEnclosureDims(board: BoardDefinition, env: HeightEnvelope, spec: EnclosureSpec): EnclosureDims {
  const innerW = board.widthMm + spec.sideClearanceMm * 2;
  const innerH = board.heightMm + spec.sideClearanceMm * 2;
  // 内腔高度 = 支柱 + PCB 厚 + 顶面器件 + 顶部净空（底面器件需在支柱高度内容纳）
  const innerDepth = spec.standoffMm + PCB_THICKNESS_MM + env.topMaxMm + spec.topClearanceMm;
  return {
    innerW, innerH, innerDepth,
    outerW: innerW + spec.wallMm * 2,
    outerH: innerH + spec.wallMm * 2,
    outerHeight: innerDepth + spec.wallMm + spec.lidMm,
    pcbBottomY: spec.standoffMm,
  };
}

/* ---------- 干涉检查 ---------- */

export interface EnclosureIssue {
  level: 'error' | 'warn' | 'info';
  code: 'bottom_clearance' | 'top_clearance' | 'side_clearance' | 'edge_component' | 'mounting_hole' | 'estimated_height' | 'wall_thin';
  message: string;
  /** 相关器件位号（若适用） */
  refs?: string[];
}

/**
 * 确定性干涉检查：全部结论可由几何算出，无 AI 推断。
 * 只报可证伪的事实（"X 高 12.0mm，可用净空 9.6mm，超 2.4mm"），不给主观评分。
 */
export function checkEnclosure(doc: CircuitCanvasDocument, spec: EnclosureSpec): EnclosureIssue[] {
  const issues: EnclosureIssue[] = [];
  const env = heightEnvelope(doc.components);
  const dims = computeEnclosureDims(doc.board, env, spec);

  // 1) 底面器件 vs 支柱高度
  if (env.bottomMaxMm > 0) {
    const avail = spec.standoffMm - spec.bottomClearanceMm;
    if (env.bottomMaxMm > avail) {
      issues.push({
        level: 'error', code: 'bottom_clearance',
        message: `底面最高器件 ${env.bottomTallest?.reference ?? ''} ${env.bottomMaxMm.toFixed(1)}mm，超过支柱可用净空 ${avail.toFixed(1)}mm（支柱 ${spec.standoffMm}mm − 净空 ${spec.bottomClearanceMm}mm），超出 ${(env.bottomMaxMm - avail).toFixed(1)}mm。请加高支柱或把该器件移到顶面。`,
        refs: env.bottomTallest ? [env.bottomTallest.reference] : undefined,
      });
    }
  }

  // 2) 顶面器件净空（外壳高度由包络推出，故此处检查用户是否手工压低了 topClearance）
  if (spec.topClearanceMm < 0.5 && env.topMaxMm > 0) {
    issues.push({
      level: 'warn', code: 'top_clearance',
      message: `顶部净空仅 ${spec.topClearanceMm}mm，装配公差与器件高度误差可能导致顶盖压住 ${env.topTallest?.reference ?? '最高器件'}。建议 ≥1mm。`,
      refs: env.topTallest ? [env.topTallest.reference] : undefined,
    });
  }

  // 3) 器件超出板框（连接器外伸是常见设计，但外壳需要开口）
  const overhang: string[] = [];
  for (const c of doc.components) {
    const fp = padFootprintFor(c.footprint.name);
    const w = fp?.bodyW ?? c.footprint.geometry.bodyWidthMm;
    const h = fp?.bodyH ?? c.footprint.geometry.bodyHeightMm;
    const rot = ((c.placement.rotation ?? 0) % 180 + 180) % 180;
    const ew = rot === 90 ? h : w, eh = rot === 90 ? w : h;
    const x0 = c.placement.xMm - ew / 2, x1 = c.placement.xMm + ew / 2;
    const y0 = c.placement.yMm - eh / 2, y1 = c.placement.yMm + eh / 2;
    if (x0 < 0 || y0 < 0 || x1 > doc.board.widthMm || y1 > doc.board.heightMm) overhang.push(c.reference);
  }
  if (overhang.length) {
    issues.push({
      level: 'info', code: 'edge_component',
      message: `${overhang.length} 个器件本体超出板框（${overhang.slice(0, 6).join('、')}${overhang.length > 6 ? '…' : ''}）：外壳侧壁需要对应开口，否则无法装入。开口位置需按实际接口面手工确认。`,
      refs: overhang,
    });
  }

  // 4) 侧向间隙
  if (spec.sideClearanceMm < 0.3) {
    issues.push({ level: 'warn', code: 'side_clearance', message: `侧向间隙 ${spec.sideClearanceMm}mm 过小，PCB 制板公差（常见 ±0.2mm）可能装不进。建议 ≥0.5mm。` });
  }

  // 5) 壁厚
  if (spec.wallMm < 1.0) {
    issues.push({ level: 'warn', code: 'wall_thin', message: `壁厚 ${spec.wallMm}mm 偏薄：3D 打印（FDM）建议 ≥1.2mm，注塑一般 1.5~3mm。` });
  }

  // 6) 定位孔 → 支柱位置提示
  const holes = effectiveMountingHoles(doc.board).length;
  if (doc.board.mountingHolesEnabled && holes === 0) {
    issues.push({ level: 'info', code: 'mounting_hole', message: '已启用定位孔但文档中无具体孔位，外壳支柱位置需要在导入真实板或手工标注孔位后才能对齐。' });
  }

  // 7) 高度数据可信度（这是结论可靠性的前提，必须显式告知）
  if (env.estimatedCount > 0) {
    issues.push({
      level: 'info', code: 'estimated_height',
      message: `${env.estimatedCount} 个器件的高度为按封装族估算（非 datasheet 实测），上述净空结论存在误差。在定制器件向导中填入机械图「高度」可提升准确度。`,
    });
  }

  void dims;
  return issues;
}

/* ---------- 导出 ---------- */

/**
 * 生成外壳底壳的三角网格 STL（ASCII）。
 * 只含"外盒 − 内腔"的简单盒体，不含开口/卡扣/支柱倒角 —— 供 3D 打印初版与尺寸核对。
 * ⚠ 不是 STEP：本工具不生成 B-rep 实体，也不宣称可直接用于注塑。
 */
export function buildEnclosureStl(board: BoardDefinition, env: HeightEnvelope, spec: EnclosureSpec, name = 'protopcb_enclosure'): string {
  const d = computeEnclosureDims(board, env, spec);
  const ow = d.outerW, oh = d.outerH, oz = d.innerDepth + spec.wallMm;
  const iw = d.innerW, ih = d.innerH;
  const t = spec.wallMm;

  const tris: string[] = [];
  const tri = (a: number[], b: number[], c: number[]) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    tris.push(`  facet normal ${(n[0] / len).toFixed(5)} ${(n[1] / len).toFixed(5)} ${(n[2] / len).toFixed(5)}
    outer loop
      vertex ${a.map((q) => q.toFixed(4)).join(' ')}
      vertex ${b.map((q) => q.toFixed(4)).join(' ')}
      vertex ${c.map((q) => q.toFixed(4)).join(' ')}
    endloop
  endfacet`);
  };
  const quad = (a: number[], b: number[], c: number[], e: number[]) => { tri(a, b, c); tri(a, c, e); };

  // 外盒（底在 z=0，开口朝 +z）与内腔（底在 z=t）
  const X0 = -ow / 2, X1 = ow / 2, Y0 = -oh / 2, Y1 = oh / 2;
  const x0 = -iw / 2, x1 = iw / 2, y0 = -ih / 2, y1 = ih / 2;

  // 外底
  quad([X0, Y0, 0], [X1, Y0, 0], [X1, Y1, 0], [X0, Y1, 0]);
  // 外侧壁 4 面
  quad([X0, Y0, 0], [X0, Y1, 0], [X0, Y1, oz], [X0, Y0, oz]);
  quad([X1, Y0, 0], [X1, Y0, oz], [X1, Y1, oz], [X1, Y1, 0]);
  quad([X0, Y0, 0], [X0, Y0, oz], [X1, Y0, oz], [X1, Y0, 0]);
  quad([X0, Y1, 0], [X1, Y1, 0], [X1, Y1, oz], [X0, Y1, oz]);
  // 内腔底
  quad([x0, y0, t], [x0, y1, t], [x1, y1, t], [x1, y0, t]);
  // 内侧壁
  quad([x0, y0, t], [x0, y0, oz], [x0, y1, oz], [x0, y1, t]);
  quad([x1, y0, t], [x1, y1, t], [x1, y1, oz], [x1, y0, oz]);
  quad([x0, y0, t], [x1, y0, t], [x1, y0, oz], [x0, y0, oz]);
  quad([x0, y1, t], [x0, y1, oz], [x1, y1, oz], [x1, y1, t]);
  // 顶部壁厚环（4 条）
  quad([X0, Y0, oz], [X0, Y1, oz], [x0, y1, oz], [x0, y0, oz]);
  quad([x1, y0, oz], [x1, y1, oz], [X1, Y1, oz], [X1, Y0, oz]);
  quad([X0, Y0, oz], [x0, y0, oz], [x1, y0, oz], [X1, Y0, oz]);
  quad([X0, Y1, oz], [X1, Y1, oz], [x1, y1, oz], [x0, y1, oz]);

  return `solid ${name}\n${tris.join('\n')}\nendsolid ${name}\n`;
}

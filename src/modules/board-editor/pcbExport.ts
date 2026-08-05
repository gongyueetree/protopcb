/**
 * modules/board-editor/pcbExport.ts
 * PCB 布局导出 —— 生成真实 KiCad 板文件（.kicad_pcb）。
 * 格式版本 20250114（KiCad 9 稳定格式）：KiCad 10 原生读取无迁移提示；
 * 声明高于实际内容的格式日期会被 KiCad 拒收，故不虚标 v10 专有常量。
 *
 * 坐标约定：KiCad 板文件 Y 轴向下，与本工具的 mm 坐标一致，位置直接映射；
 * 旋转：KiCad 正角为逆时针（屏幕视角），本工具 SVG 正角为顺时针 → kicadRot = (360 - rot) % 360。
 * 层：TOP → F.Cu，BOTTOM → B.Cu（焊盘层随之取 B.Cu/B.Paste/B.Mask）。
 * 定位孔：以非金属化通孔（NPTH）焊盘输出。
 *
 * 嘉立创EDA专业版：文件 → 导入 → KiCad，可直接导入本文件。
 * Altium：.PcbDoc 为专有二进制格式，前端无法生成；较新版 AD 的 Import Wizard 支持导入 KiCad 工程。
 */
import { lshapeCut } from '../../design-core/collision';
import type { CircuitCanvasDocument, PlacedComponent } from '../../design-core/document/types';
import { padFootprintFor } from '../../design-core/geometry/footprint-pads';
import { mountingHoleCenters, HOLE_DIAMETER_MM } from '../../design-core/collision';

const F = (n: number) => +n.toFixed(4);

/** 板框 Edge.Cuts 图元 */
function edgeCuts(doc: CircuitCanvasDocument): string[] {
  const W = doc.board.widthMm, H = doc.board.heightMm;
  const L: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    L.push(`  (gr_line (start ${F(x1)} ${F(y1)}) (end ${F(x2)} ${F(y2)}) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))`);

  if (doc.board.shape === 'circle') {
    const r = Math.min(W, H) / 2;
    L.push(`  (gr_circle (center ${F(W / 2)} ${F(H / 2)}) (end ${F(W / 2 + r)} ${F(H / 2)}) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts"))`);
    return L;
  }
  if (doc.board.shape === 'lshape') {
    // 切角尺寸随设置；圆角在制造导出中省略（KiCad 内可后期倒角）
    const { cutW: cw, cutH: ch } = lshapeCut(doc.board);
    line(0, 0, W, 0);
    line(W, 0, W, H - ch);
    line(W, H - ch, W - cw, H - ch);
    line(W - cw, H - ch, W - cw, H);
    line(W - cw, H, 0, H);
    line(0, H, 0, 0);
    return L;
  }
  if (doc.board.shape === 'rounded') {
    const r = Math.min(W, H) * 0.08;
    // 四条边 + 四个圆角（gr_arc: start=弧起点 mid=弧中点 end=弧终点）
    line(r, 0, W - r, 0);
    line(W, r, W, H - r);
    line(W - r, H, r, H);
    line(0, H - r, 0, r);
    const k = r * (1 - Math.SQRT1_2); // 45° 点偏移
    L.push(`  (gr_arc (start ${F(W - r)} 0) (mid ${F(W - k)} ${F(k)}) (end ${F(W)} ${F(r)}) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))`);
    L.push(`  (gr_arc (start ${F(W)} ${F(H - r)}) (mid ${F(W - k)} ${F(H - k)}) (end ${F(W - r)} ${F(H)}) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))`);
    L.push(`  (gr_arc (start ${F(r)} ${F(H)}) (mid ${F(k)} ${F(H - k)}) (end 0 ${F(H - r)}) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))`);
    L.push(`  (gr_arc (start 0 ${F(r)}) (mid ${F(k)} ${F(k)}) (end ${F(r)} 0) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))`);
    return L;
  }
  // 矩形
  line(0, 0, W, 0); line(W, 0, W, H); line(W, H, 0, H); line(0, H, 0, 0);
  return L;
}

/** 单个器件 → footprint 块 */
function footprintBlock(c: PlacedComponent): string {
  const fp = padFootprintFor(c.footprint.name);
  const isBottom = c.placement.side === 'BOTTOM';
  const layer = isBottom ? 'B.Cu' : 'F.Cu';
  const kicadRot = (360 - c.placement.rotation) % 360;
  const L: string[] = [];
  L.push(`  (footprint "CircuitCanvas:${c.footprint.name}" (layer "${layer}")`);
  L.push(`    (at ${F(c.placement.xMm)} ${F(c.placement.yMm)} ${kicadRot})`);
  L.push(`    (attr smd)`);
  const refLayer = isBottom ? 'B.SilkS' : 'F.SilkS';
  const fabLayer = isBottom ? 'B.Fab' : 'F.Fab';
  const bodyH = fp?.bodyH ?? c.footprint.geometry.bodyHeightMm;
  // 位号/值放在 本体+焊盘 总范围之外（避免丝印压焊盘 DRC）
  const extTop = fp ? Math.max(...fp.pads.map((p2) => Math.abs(p2.y) + p2.h / 2), Math.abs(fp.bodyCy ?? 0) + fp.bodyH / 2) : bodyH / 2;
  const silkY = extTop + 1.5;
  L.push(`    (fp_text reference "${c.reference}" (at 0 ${F(-silkY)} ${kicadRot}) (layer "${refLayer}")${c.refDesDisplay?.hidden ? ' hide' : ''} (effects (font (size 0.8 0.8) (thickness 0.12))${isBottom ? ' (justify mirror)' : ''}))`);
  L.push(`    (fp_text value "${c.mpn.replace(/"/g, '')}" (at 0 ${F(silkY)} ${kicadRot}) (layer "${fabLayer}") (effects (font (size 0.8 0.8) (thickness 0.12))${isBottom ? ' (justify mirror)' : ''}))`);
  if (fp) {
    // 丝印本体框
    const hw = fp.bodyW / 2, hh = fp.bodyH / 2, bcx = fp.bodyCx ?? 0, bcy = fp.bodyCy ?? 0;
    L.push(`    (fp_rect (start ${F(bcx - hw)} ${F(bcy - hh)}) (end ${F(bcx + hw)} ${F(bcy + hh)}) (stroke (width 0.12) (type solid)) (layer "${refLayer}"))`);
    for (const p of fp.pads) {
      if (p.round) {
        const drill = Math.max(0.8, p.w - 0.6);
        L.push(`    (pad "${p.num}" thru_hole circle (at ${F(p.x)} ${F(p.y)} ${kicadRot}) (size ${F(p.w)} ${F(p.h)}) (drill ${F(drill)}) (layers "*.Cu" "*.Mask"))`);
      } else {
        const padLayers = isBottom ? '"B.Cu" "B.Paste" "B.Mask"' : '"F.Cu" "F.Paste" "F.Mask"';
        L.push(`    (pad "${p.num}" smd roundrect (at ${F(p.x)} ${F(p.y)} ${kicadRot}) (size ${F(p.w)} ${F(p.h)}) (layers ${padLayers}) (roundrect_rratio 0.15))`);
      }
    }
  } else {
    // 无焊盘数据：以 courtyard 画 Fab 框占位
    const hw = c.footprint.geometry.bodyWidthMm / 2, hh = c.footprint.geometry.bodyHeightMm / 2;
    L.push(`    (fp_rect (start ${F(-hw)} ${F(-hh)}) (end ${F(hw)} ${F(hh)}) (stroke (width 0.12) (type solid)) (layer "${fabLayer}"))`);
  }
  L.push(`  )`);
  return L.join('\n');
}

/** 定位孔 → NPTH footprint */
function holeBlock(x: number, y: number, idx: number): string {
  const d = HOLE_DIAMETER_MM;
  return [
    `  (footprint "CircuitCanvas:MountingHole_${d}mm" (layer "F.Cu")`,
    `    (at ${F(x)} ${F(y)})`,
    `    (attr exclude_from_pos_files exclude_from_bom)`,
    `    (fp_text reference "H${idx}" (at 0 ${F(-(d / 2 + 1))}) (layer "F.SilkS") hide (effects (font (size 0.8 0.8) (thickness 0.12))))`,
    `    (fp_text value "MountingHole" (at 0 ${F(d / 2 + 1)}) (layer "F.Fab") (effects (font (size 0.8 0.8) (thickness 0.12))))`,
    `    (pad "" np_thru_hole circle (at 0 0) (size ${F(d)} ${F(d)}) (drill ${F(d)}) (layers "*.Cu" "*.Mask"))`,
    `  )`,
  ].join('\n');
}

/** 生成完整 .kicad_pcb 文本 */
export function buildKicadPcb(doc: CircuitCanvasDocument): string {
  const L: string[] = [];
  L.push(`(kicad_pcb (version 20250114) (generator "circuit_canvas") (generator_version "1.0")`);
  L.push(``);
  L.push(`  (general (thickness 1.6))`);
  L.push(`  (paper "A4")`);
  L.push(`  (title_block (title "${(doc.name || 'Circuit Canvas Design').replace(/"/g, '')}") (comment 1 "Generated by Circuit Canvas · ezPLM.cn"))`);
  L.push(``);
  L.push(`  (layers`);
  L.push(`    (0 "F.Cu" signal)`);
  L.push(`    (31 "B.Cu" signal)`);
  L.push(`    (32 "B.Adhes" user "B.Adhesive")`);
  L.push(`    (33 "F.Adhes" user "F.Adhesive")`);
  L.push(`    (34 "B.Paste" user)`);
  L.push(`    (35 "F.Paste" user)`);
  L.push(`    (36 "B.SilkS" user "B.Silkscreen")`);
  L.push(`    (37 "F.SilkS" user "F.Silkscreen")`);
  L.push(`    (38 "B.Mask" user)`);
  L.push(`    (39 "F.Mask" user)`);
  L.push(`    (44 "Edge.Cuts" user)`);
  L.push(`    (46 "B.CrtYd" user "B.Courtyard")`);
  L.push(`    (47 "F.CrtYd" user "F.Courtyard")`);
  L.push(`    (48 "B.Fab" user)`);
  L.push(`    (49 "F.Fab" user)`);
  L.push(`  )`);
  L.push(``);
  L.push(`  (setup (pad_to_mask_clearance 0))`);
  L.push(``);
  L.push(`  (net 0 "")`);
  L.push(``);
  // 板框
  L.push(...edgeCuts(doc));
  L.push(``);
  // 定位孔
  mountingHoleCenters(doc.board).forEach((c, i) => { L.push(holeBlock(c.x, c.y, i + 1)); L.push(``); });
  // 器件
  for (const c of doc.components) { L.push(footprintBlock(c)); L.push(``); }
  L.push(`)`);
  return L.join('\n');
}

export function downloadKicadPcb(doc: CircuitCanvasDocument) {
  const text = buildKicadPcb(doc);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `${(doc.name || 'design').replace(/\s+/g, '_')}.kicad_pcb`;
  a.click();
  URL.revokeObjectURL(a.href);
}

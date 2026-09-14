/**
 * design-core/collision/index.ts
 * 碰撞检测引擎 —— 基于 courtyard 矩形，纯函数。
 */
import type { PlacedComponent, BoardDefinition } from '../document/types';
import { footprintCourtyardRect, rectsOverlap, clampRectInside, type Rect } from '../geometry';
import { padFootprintFor } from '../geometry/footprint-pads';
import { effectiveMountingHoles } from '../board/mounting-holes';

export const DEFAULT_GAP_MM = 3;
export const BOARD_MARGIN_MM = 2;
export const HOLE_MARGIN_MM = 4; // 定位孔距板边
export const HOLE_DIAMETER_MM = 3.2;

/** 四角定位孔的中心点 + 禁布矩形（含间隙）。 */
export function mountingHoleRects(board: BoardDefinition): Rect[] {
  const r = HOLE_DIAMETER_MM / 2 + DEFAULT_GAP_MM;
  return mountingHoleCenters(board).map((c) => ({ x: c.x - r, y: c.y - r, width: r * 2, height: r * 2 }));
}

/** 定位孔中心点（用于渲染）。L 形板右下缺口区域的孔移到缺口上方板内。 */
/** L 形切角尺寸（mm）：可配置，缺省 45%W / 40%H，并夹取到合法范围 */
export function lshapeCut(board: BoardDefinition): { cutW: number; cutH: number } {
  const W = board.widthMm, H = board.heightMm;
  const cutW = Math.min(W * 0.9, Math.max(5, board.cutWidthMm ?? W * 0.45));
  const cutH = Math.min(H * 0.9, Math.max(5, board.cutHeightMm ?? H * 0.4));
  return { cutW, cutH };
}

export function mountingHoleCenters(board: BoardDefinition): { x: number; y: number }[] {
  // 唯一数据源：不再自己按四角推算（那会与导入工程的真实孔位打架）
  return effectiveMountingHoles(board).map((h) => ({ x: h.position.x, y: h.position.y }));
}

/** 取器件的 courtyard 矩形（mm，板坐标系）。 */
export function componentRect(c: PlacedComponent): Rect {
  return footprintCourtyardRect(c.footprint.geometry, { x: c.placement.xMm, y: c.placement.yMm }, c.placement.rotation);
}

/** 板框可用矩形（暂以外接矩形近似，异形由 keepout 进一步约束）。 */
export function boardRect(board: BoardDefinition): Rect {
  return { x: 0, y: 0, width: board.widthMm, height: board.heightMm };
}

/** 某器件是否与其它器件重叠。 */
export function hasOverlap(target: PlacedComponent, others: PlacedComponent[], gap = DEFAULT_GAP_MM): boolean {
  const r = componentRect(target);
  return others.some((o) => o.instanceId !== target.instanceId && o.placement.side === target.placement.side && rectsOverlap(r, componentRect(o), gap));
}

/** 返回所有存在重叠的器件 instanceId 集合（仅同层比较）。 */
/**
 * 判定"真正的重叠"用的间距。
 *
 * ⚠ 不要用 DEFAULT_GAP_MM（3mm）—— 那是**自动布局的目标间距**，是审美/可制造性偏好，
 * 不是冲突阈值。真实量产板上 0402 之间常常只有 0.3~0.5mm，用 3mm 判定会把整块
 * 导入的板子全部标成"重叠"（88 个器件全红），提示就完全失去意义了。
 * 这里用 0：courtyard 真正相交才算重叠 —— courtyard 本身已经含了工艺间距。
 */
export const OVERLAP_GAP_MM = 0;

/**
 * 器件实体外接矩形 —— **判定重叠专用**，与 componentRect（courtyard）不同。
 *
 * courtyard = 焊盘外沿 + 0.6mm 装配余量，那个余量是给自动布局留手的；
 * 拿它判重叠，等于要求真实板上每两个器件之间至少空 1.2mm，
 * 于是一块正常的密集板（0201/0402 间距 0.3~0.5mm）会被判出几十处"重叠"。
 * 这里取焊盘与本体的真实外沿，不含余量：**焊盘真的压到一起才算重叠**。
 */
export function componentExtentRect(c: PlacedComponent): Rect {
  const fp = padFootprintFor(c.footprint.name);
  if (fp && fp.pads.length) {
    const exW = Math.max(...fp.pads.map((p) => Math.abs(p.x) + p.w / 2), fp.bodyW / 2) * 2;
    const exH = Math.max(...fp.pads.map((p) => Math.abs(p.y) + p.h / 2), fp.bodyH / 2) * 2;
    const swap = Math.abs(c.placement.rotation % 180) === 90;
    const w = swap ? exH : exW, h = swap ? exW : exH;
    return { x: c.placement.xMm - w / 2, y: c.placement.yMm - h / 2, width: w, height: h };
  }
  // 没有真实焊盘数据：退回 courtyard，但扣掉那 0.6mm 余量
  const r = componentRect(c);
  const m = 0.6;
  return { x: r.x + m / 2, y: r.y + m / 2, width: Math.max(0.1, r.width - m), height: Math.max(0.1, r.height - m) };
}

export function findOverlaps(components: PlacedComponent[], gap = OVERLAP_GAP_MM): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      if (components[i].placement.side !== components[j].placement.side) continue;
      if (rectsOverlap(componentExtentRect(components[i]), componentExtentRect(components[j]), gap)) {
        set.add(components[i].instanceId);
        set.add(components[j].instanceId);
      }
    }
  }
  return set;
}

export const DRAG_GAP_MM = 0.5;

/** 拖拽时校验：目标中心点是否与其它同层器件/定位孔保持间距。 */
export function isPositionFree(
  target: PlacedComponent, xMm: number, yMm: number,
  others: PlacedComponent[], board: BoardDefinition, gap = DRAG_GAP_MM
): boolean {
  const moved = { ...target, placement: { ...target.placement, xMm, yMm } };
  const r = componentRect(moved);
  for (const o of others) {
    if (o.instanceId === target.instanceId || o.placement.side !== target.placement.side) continue;
    if (rectsOverlap(r, componentRect(o), gap)) return false;
  }
  for (const hr of mountingHoleRects(board)) {
    if (rectsOverlap(r, hr, 0)) return false;
  }
  return true;
}

/** 把器件中心点夹紧，使 courtyard 完整落在板框内。返回新的中心点。 */
export function clampComponentToBoard(c: PlacedComponent, board: BoardDefinition): { x: number; y: number } {
  const r = componentRect(c);
  // 连接器多为板边器件（USB/排针/天线座），常需贴边或外伸；沿用 2mm 内缩会导致"移动不到位"
  const isEdgePart = c.category === 'connector'
    || /CONN|USB|PINHEADER|PINSOCKET|RECEPTACLE|MMCX|SMA|TERMINAL|JACK|HEADER/i.test(c.footprint.name);
  const margin = isEdgePart ? -Math.max(r.width, r.height) / 2 : BOARD_MARGIN_MM;
  const clamped = clampRectInside(r, boardRect(board), margin);
  // clamped 是左上角，转回中心
  return { x: clamped.x + r.width / 2, y: clamped.y + r.height / 2 };
}

/**
 * design-core/collision/index.ts
 * 碰撞检测引擎 —— 基于 courtyard 矩形，纯函数。
 */
import type { PlacedComponent, BoardDefinition } from '../document/types';
import { footprintCourtyardRect, rectsOverlap, clampRectInside, type Rect } from '../geometry';

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
export function mountingHoleCenters(board: BoardDefinition): { x: number; y: number }[] {
  if (!board.mountingHolesEnabled || board.shape === 'circle') return [];
  const m = HOLE_MARGIN_MM, W = board.widthMm, H = board.heightMm;
  if (board.shape === 'lshape') {
    // 缺口: x > W-0.45W 且 y > H-0.4H 被切除 → 右下孔放到缺口上沿以内
    const cutH = H * 0.4;
    return [{ x: m, y: m }, { x: W - m, y: m }, { x: m, y: H - m }, { x: W - m, y: H - cutH - m }];
  }
  return [{ x: m, y: m }, { x: W - m, y: m }, { x: m, y: H - m }, { x: W - m, y: H - m }];
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
export function findOverlaps(components: PlacedComponent[], gap = DEFAULT_GAP_MM): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      if (components[i].placement.side !== components[j].placement.side) continue;
      if (rectsOverlap(componentRect(components[i]), componentRect(components[j]), gap)) {
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
  const clamped = clampRectInside(r, boardRect(board), BOARD_MARGIN_MM);
  // clamped 是左上角，转回中心
  return { x: clamped.x + r.width / 2, y: clamped.y + r.height / 2 };
}

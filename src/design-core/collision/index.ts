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

/**
 * 器件与定位孔的最小净空（mm）。
 * KiCad 的 MountingHole 封装自带 courtyard：孔径外再放约 1mm（M3 孔 3.2mm → courtyard ≈ 5.2mm），
 * 实际装配还要留螺母/垫圈的旋转空间。这里取 1.0mm，比 courtyard 略紧但明显严于"不相交"，
 * 既不会把导入的真实板误判成一片冲突，又能挡住压在孔上的器件。
 */
export const HOLE_CLEARANCE_MM = 1.0;

/** 定位孔的禁布圆（中心 + 半径，含净空） */
export function holeKeepouts(board: BoardDefinition): { x: number; y: number; r: number }[] {
  return effectiveMountingHoles(board).map((h) => ({
    x: h.position.x, y: h.position.y, r: h.diameterMm / 2 + HOLE_CLEARANCE_MM,
  }));
}

/** 矩形与圆是否相交（判定器件是否压到定位孔） */
function rectHitsCircle(r: Rect, c: { x: number; y: number; r: number }): boolean {
  const nx = Math.max(r.x, Math.min(c.x, r.x + r.width));
  const ny = Math.max(r.y, Math.min(c.y, r.y + r.height));
  return (nx - c.x) ** 2 + (ny - c.y) ** 2 < c.r ** 2;
}

/** 该器件是否与任一定位孔（含净空）冲突 */
export function hitsMountingHole(c: PlacedComponent, board: BoardDefinition): boolean {
  const rect = componentExtentRect(c);
  return holeKeepouts(board).some((k) => rectHitsCircle(rect, k));
}

/**
 * 重叠检测。传入 board 时同时检查定位孔冲突 ——
 * 此前只比器件两两之间，压在安装孔上的器件一路绿灯到导出。
 */
export function findOverlaps(components: PlacedComponent[], gap = OVERLAP_GAP_MM, board?: BoardDefinition): Set<string> {
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
  if (board) {
    const keepouts = holeKeepouts(board);
    if (keepouts.length) {
      for (const c of components) {
        const rect = componentExtentRect(c);
        if (keepouts.some((k) => rectHitsCircle(rect, k))) set.add(c.instanceId);
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

/**
 * 拖放落点求解。
 *
 * 取舍：器件之间**不硬性阻止**重叠 —— 导入的密集板处处 0.3mm 间距，硬拦会让人完全拖不动；
 * 但会先在小半径内找一个满足间距的落点（轻推），找不到才按原位落下并标红。
 * 定位孔不同：那是机械约束（螺柱/螺母要占空间），一律推开，找不到就拒绝这次移动。
 *
 * @param gap 器件间目标间距，缺省 DRAG_GAP_MM（0.5mm，接近 KiCad 默认 courtyard 间隙）
 * @returns 最终落点；rejected=true 表示孔位冲突且附近无处可放，调用方应放弃本次移动
 */
export function resolveDropPosition(
  target: PlacedComponent, xMm: number, yMm: number,
  others: PlacedComponent[], board: BoardDefinition,
  { gap = DRAG_GAP_MM, searchRadiusMm, stepMm = 0.25 }: { gap?: number; searchRadiusMm?: number; stepMm?: number } = {},
): { x: number; y: number; nudged: boolean; overlapping: boolean; rejected: boolean } {
  // 搜索半径按器件自身尺寸定：两个 SOIC-8 完全重叠时要推开一个身位才可能不相交，
  // 固定 6mm 对大器件根本不够（0402 则远远用不到）
  const self = componentRect(target);
  const radius = searchRadiusMm ?? Math.min(20, Math.max(4, Math.hypot(self.width, self.height)));
  const keepouts = holeKeepouts(board);
  const sameSide = others.filter((o) => o.instanceId !== target.instanceId && o.placement.side === target.placement.side);

  const at = (x: number, y: number) => ({ ...target, placement: { ...target.placement, xMm: x, yMm: y } });
  const hitsHole = (x: number, y: number) => {
    if (!keepouts.length) return false;
    const r = componentExtentRect(at(x, y));
    return keepouts.some((k) => rectHitsCircle(r, k));
  };
  const hitsPart = (x: number, y: number) => {
    const r = componentRect(at(x, y));
    return sameSide.some((o) => rectsOverlap(r, componentRect(o), gap));
  };

  if (!hitsHole(xMm, yMm) && !hitsPart(xMm, yMm)) {
    return { x: xMm, y: yMm, nudged: false, overlapping: false, rejected: false };
  }

  // 螺旋搜索最近的合法点（步进 0.25mm，半径 6mm）
  let holeFree: { x: number; y: number } | null = null;
  for (let rad = stepMm; rad <= radius; rad += stepMm) {
    const steps = Math.max(8, Math.round((2 * Math.PI * rad) / stepMm / 4));
    for (let i = 0; i < steps; i++) {
      const a = (2 * Math.PI * i) / steps;
      const x = xMm + rad * Math.cos(a), y = yMm + rad * Math.sin(a);
      const hole = hitsHole(x, y);
      if (!hole && !holeFree) holeFree = { x, y };          // 至少避开了孔
      if (!hole && !hitsPart(x, y)) return { x, y, nudged: true, overlapping: false, rejected: false };
    }
  }
  // 找不到完全合法的点：孔位必须避开，器件重叠可以接受（标红提示）
  if (hitsHole(xMm, yMm)) {
    return holeFree
      ? { x: holeFree.x, y: holeFree.y, nudged: true, overlapping: true, rejected: false }
      : { x: target.placement.xMm, y: target.placement.yMm, nudged: false, overlapping: false, rejected: true };
  }
  return { x: xMm, y: yMm, nudged: false, overlapping: true, rejected: false };
}

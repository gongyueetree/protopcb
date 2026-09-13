/**
 * modules/board-editor/board-view-constants.ts
 * PCB 画布的坐标常量与映射 —— 2D SVG 与 3D 投影层**共用同一套**，
 * 这是投影不漂移的前提：任何一边私藏一份常量，缩放后就会错位。
 */
import { PX_PER_MM } from '../../design-core/geometry';
import { padFootprintFor } from '../../design-core/geometry/footprint-pads';
import type { PlacedComponent } from '../../design-core/document/types';

/** 板框左上角在 SVG 中的像素偏移（未缩放） */
export const BOARD_ORIGIN_PX = { x: 60, y: 40 } as const;

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * 板坐标(mm) → 屏幕像素。
 * 与 BoardCanvas2D 的 `translate(pan) scale(zoom)` 完全等价：
 *   screen = pan + (ORIGIN + mm * PX_PER_MM) * zoom
 */
export function boardMmToScreenPx(xMm: number, yMm: number, vp: Viewport): { x: number; y: number } {
  return {
    x: vp.panX + (BOARD_ORIGIN_PX.x + xMm * PX_PER_MM) * vp.zoom,
    y: vp.panY + (BOARD_ORIGIN_PX.y + yMm * PX_PER_MM) * vp.zoom,
  };
}

/** 屏幕像素 → 板坐标(mm)（上面的逆变换） */
export function screenPxToBoardMm(x: number, y: number, vp: Viewport): { xMm: number; yMm: number } {
  return {
    xMm: ((x - vp.panX) / vp.zoom - BOARD_ORIGIN_PX.x) / PX_PER_MM,
    yMm: ((y - vp.panY) / vp.zoom - BOARD_ORIGIN_PX.y) / PX_PER_MM,
  };
}

/** 当前视口下 1mm 对应多少屏幕像素 */
export const pxPerMmAt = (zoom: number) => PX_PER_MM * zoom;

/**
 * 正交相机参数：让 WebGL 画布与 2D SVG 像素级对齐。
 *
 * 相机看向 -Y（俯视），场景用**板中心**为原点（与 BoardView3D 一致），
 * 因此需要算出：画布中心对应的板坐标，以及可视范围的 mm 尺寸。
 */
export function orthoCameraParams(
  canvasW: number, canvasH: number,
  boardWmm: number, boardHmm: number,
  vp: Viewport,
): { centerXmm: number; centerZmm: number; halfWmm: number; halfHmm: number } {
  const scale = pxPerMmAt(vp.zoom);
  // 画布中心像素 → 板坐标
  const c = screenPxToBoardMm(canvasW / 2, canvasH / 2, vp);
  return {
    // 场景原点在板中心，所以要减去板的一半
    centerXmm: c.xMm - boardWmm / 2,
    centerZmm: c.yMm - boardHmm / 2,
    halfWmm: canvasW / 2 / scale,
    halfHmm: canvasH / 2 / scale,
  };
}

/**
 * 选中框几何（px，未缩放）——基础层与顶层 overlay 必须用同一份，
 * 否则混合视图下会出现两个错位的虚线框（overlay 用 body 矩形、基础层用焊盘外沿）。
 */
export function selectionBoxPx(comp: PlacedComponent): { cx: number; cy: number; rot: number; mirror: boolean; x: number; y: number; w: number; h: number } | null {
  const fp = padFootprintFor(comp.footprint.name);
  const cx = BOARD_ORIGIN_PX.x + comp.placement.xMm * PX_PER_MM;
  const cy = BOARD_ORIGIN_PX.y + comp.placement.yMm * PX_PER_MM;
  if (!fp || !fp.pads.length) {
    const g = comp.footprint.geometry;
    const w = g.bodyWidthMm * PX_PER_MM, h = g.bodyHeightMm * PX_PER_MM;
    return { cx, cy, rot: comp.placement.rotation, mirror: comp.placement.side === 'BOTTOM', x: -w / 2 - 4, y: -h / 2 - 4, w: w + 8, h: h + 8 };
  }
  const xs = fp.pads.map((p) => [p.x - p.w / 2, p.x + p.w / 2]).flat().concat([(fp.bodyCx ?? 0) - fp.bodyW / 2, (fp.bodyCx ?? 0) + fp.bodyW / 2]);
  const ys = fp.pads.map((p) => [p.y - p.h / 2, p.y + p.h / 2]).flat().concat([(fp.bodyCy ?? 0) - fp.bodyH / 2, (fp.bodyCy ?? 0) + fp.bodyH / 2]);
  const x0 = Math.min(...xs) * PX_PER_MM, x1 = Math.max(...xs) * PX_PER_MM;
  const y0 = Math.min(...ys) * PX_PER_MM, y1 = Math.max(...ys) * PX_PER_MM;
  return { cx, cy, rot: comp.placement.rotation, mirror: comp.placement.side === 'BOTTOM', x: x0 - 4, y: y0 - 4, w: x1 - x0 + 8, h: y1 - y0 + 8 };
}

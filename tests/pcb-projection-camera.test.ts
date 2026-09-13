/**
 * 投影相机与 2D 画布的像素级对齐
 * 要求：任意缩放/平移下，器件中心的投影像素与 SVG 像素误差 < 1px
 */
import { describe, it, expect } from 'vitest';
import { boardMmToScreenPx, screenPxToBoardMm, orthoCameraParams, BOARD_ORIGIN_PX, pxPerMmAt } from '../src/modules/board-editor/board-view-constants';
import { PX_PER_MM } from '../src/design-core/geometry';

const VPS = [
  { zoom: 0.2, panX: 0, panY: 0 },
  { zoom: 0.5, panX: -120, panY: 60 },
  { zoom: 1, panX: 0, panY: 0 },
  { zoom: 2, panX: 340, panY: -220 },
  { zoom: 5, panX: -1500, panY: 900 },
];

describe('世界 ↔ 屏幕映射', () => {
  it('映射公式与 BoardCanvas2D 的 translate+scale 完全一致', () => {
    for (const vp of VPS) {
      const p = boardMmToScreenPx(12.5, 7.25, vp);
      expect(p.x).toBeCloseTo(vp.panX + (BOARD_ORIGIN_PX.x + 12.5 * PX_PER_MM) * vp.zoom, 9);
      expect(p.y).toBeCloseTo(vp.panY + (BOARD_ORIGIN_PX.y + 7.25 * PX_PER_MM) * vp.zoom, 9);
    }
  });

  it('正逆变换可往返', () => {
    for (const vp of VPS) {
      const p = boardMmToScreenPx(33, 21, vp);
      const b = screenPxToBoardMm(p.x, p.y, vp);
      expect(b.xMm).toBeCloseTo(33, 6);
      expect(b.yMm).toBeCloseTo(21, 6);
    }
  });
});

describe('正交相机参数', () => {
  const W = 900, H = 600, BW = 100, BH = 80;

  /** 用相机参数把板坐标换算回画布像素（模拟 WebGL 投影） */
  function projectViaCamera(xMm: number, yMm: number, vp: { zoom: number; panX: number; panY: number }) {
    const p = orthoCameraParams(W, H, BW, BH, vp);
    // 场景坐标（板中心为原点）
    const sx = xMm - BW / 2, sz = yMm - BH / 2;
    // 正交投影 → NDC → 画布像素（相机 up=-z，故 z 方向与屏幕 y 同向）
    const ndcX = (sx - p.centerXmm) / p.halfWmm;
    const ndcY = (sz - p.centerZmm) / p.halfHmm;
    return { x: (ndcX * 0.5 + 0.5) * W, y: (ndcY * 0.5 + 0.5) * H };
  }

  it('各缩放级别下，投影像素与 SVG 像素误差 < 1px', () => {
    for (const vp of VPS) {
      for (const [xMm, yMm] of [[0, 0], [50, 40], [100, 80], [12.3, 67.8]]) {
        const svg = boardMmToScreenPx(xMm, yMm, vp);
        const gl = projectViaCamera(xMm, yMm, vp);
        expect(Math.abs(svg.x - gl.x)).toBeLessThan(1);
        expect(Math.abs(svg.y - gl.y)).toBeLessThan(1);
      }
    }
  });

  it('可视范围随 zoom 反比变化（1mm 对应的像素数正比于 zoom）', () => {
    const a = orthoCameraParams(W, H, BW, BH, { zoom: 1, panX: 0, panY: 0 });
    const b = orthoCameraParams(W, H, BW, BH, { zoom: 2, panX: 0, panY: 0 });
    expect(a.halfWmm / b.halfWmm).toBeCloseTo(2, 6);
    expect(pxPerMmAt(2) / pxPerMmAt(1)).toBeCloseTo(2, 9);
  });
});

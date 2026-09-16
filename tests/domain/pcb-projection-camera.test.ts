/**
 * 投影相机与 2D 画布的像素级对齐
 * 要求：任意缩放/平移下，器件中心的投影像素与 SVG 像素误差 < 1px
 */
import { describe, it, expect } from 'vitest';
import { boardMmToScreenPx, screenPxToBoardMm, orthoCameraParams, BOARD_ORIGIN_PX, pxPerMmAt } from '../../src/modules/board-editor/board-view-constants';
import { PX_PER_MM } from '../../src/design-core/geometry';
import * as THREE from 'three';

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

describe('正交相机参数（用真实 Three.js 投影验证）', () => {
  const W = 900, H = 600, BW = 100, BH = 80;

  /**
   * 用**真正的 THREE.OrthographicCamera** 投影，而不是重算一遍我自己的公式 ——
   * 只测自己的公式会漏掉 up 向量、top/bottom 约定这类"公式对但相机设错"的 bug
   * （实测就漏掉过一次上下翻转）。
   */
  function projectViaCamera(xMm: number, yMm: number, vp: { zoom: number; panX: number; panY: number }) {
    const p = orthoCameraParams(W, H, BW, BH, vp);
    const cam = new THREE.OrthographicCamera(-p.halfWmm, p.halfWmm, p.halfHmm, -p.halfHmm, 0.1, 2000);
    cam.up.set(0, 0, -1);
    cam.position.set(p.centerXmm, 500, p.centerZmm);
    cam.lookAt(p.centerXmm, 0, p.centerZmm);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const v = new THREE.Vector3(xMm - BW / 2, 0, yMm - BH / 2).project(cam);
    return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
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

describe('画布尺寸与设备像素比', () => {
  it('renderer.setSize 必须更新 CSS 尺寸（否则 DPR=2 时画布按两倍显示）', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/modules/board-editor/PcbProjection3DLayer.tsx', import.meta.url), 'utf8'));
    // 不能出现 setSize(w, h, false) —— 第三个参数 false 会跳过 CSS 尺寸设置
    expect(src).not.toMatch(/setSize\([^)]*,\s*false\)/);
    expect(src).toMatch(/setPixelRatio\(Math\.min\(window\.devicePixelRatio,\s*2\)\)/);
  });

  it('相机 top/bottom 用常规约定（up=-z 已经完成一次翻转）', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/modules/board-editor/PcbProjection3DLayer.tsx', import.meta.url), 'utf8'));
    expect(src).toMatch(/cam\.top = p\.halfHmm;\s*cam\.bottom = -p\.halfHmm;/);
  });
});

describe('缩放时视口原子更新（回归：3D 与焊盘脱离直到下一次点击）', () => {
  it('滚轮缩放不得使用嵌套的 setZoom→setPan（会拆成两帧发布"新 zoom + 旧 pan"）', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/modules/board-editor/BoardCanvas2D.tsx', import.meta.url), 'utf8'));
    const wheel = src.slice(src.indexOf('const onWheel'), src.indexOf("addEventListener('wheel'"));
    expect(wheel).not.toMatch(/setZoom\(\s*\(prev\)\s*=>[\s\S]*setPan\(/);
    // 必须先从同步真值算出 zoom 与 pan，再各自 set 一次
    expect(wheel).toMatch(/viewMemory\.zoom/);
    expect(wheel).toMatch(/viewMemory\.pan/);
  });

  it('投影层的相机同步在尺寸变化与场景同步时也会执行', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/modules/board-editor/PcbProjection3DLayer.tsx', import.meta.url), 'utf8'));
    expect((src.match(/syncCamera\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

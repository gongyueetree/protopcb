import { describe, it, expect } from 'vitest';

/** 与 board-texture 同款：焊盘随器件旋转的变换（KiCad 逆时针 → -rot） */
function padWorld(cx: number, cy: number, rot: number, px: number, py: number, pw: number, ph: number) {
  const deg = -rot * Math.PI / 180;
  const cos = Math.cos(deg), sin = Math.sin(deg);
  const swap = Math.abs(rot % 180) === 90;
  return {
    x: +(cx + px * cos - py * sin).toFixed(4),
    y: +(cy + px * sin + py * cos).toFixed(4),
    w: swap ? ph : pw,
    h: swap ? pw : ph,
  };
}

/** 贴图分辨率钳制：大板不得超过纹理上限 */
function texSize(W: number, H: number, pxPerMm = 8, maxPx = 4096) {
  const scale = Math.min(pxPerMm, maxPx / Math.max(W, H));
  return { w: Math.max(2, Math.round(W * scale)), h: Math.max(2, Math.round(H * scale)), scale };
}

describe('PCB 板面贴图', () => {
  it('焊盘随器件旋转，且 90° 时宽高互换', () => {
    const p0 = padWorld(10, 5, 0, 0.8, 0, 0.9, 1.2);
    expect(p0).toEqual({ x: 10.8, y: 5, w: 0.9, h: 1.2 });
    const p90 = padWorld(10, 5, 90, 0.8, 0, 0.9, 1.2);
    expect(p90.x).toBeCloseTo(10);
    expect(p90.y).toBeCloseTo(4.2);       // -rot：逆时针
    expect(p90.w).toBe(1.2);              // 宽高互换
    expect(p90.h).toBe(0.9);
  });

  it('180° 旋转把焊盘翻到对侧', () => {
    const p = padWorld(10, 5, 180, 0.8, 0, 0.9, 1.2);
    expect(p.x).toBeCloseTo(9.2);
    expect(p.y).toBeCloseTo(5);
    expect(p.w).toBe(0.9);
  });

  it('贴图尺寸随板长钳制在纹理上限内', () => {
    const small = texSize(51, 23);
    expect(small).toMatchObject({ w: 408, h: 184 });   // 真实测试板 8px/mm
    const huge = texSize(800, 600);
    expect(Math.max(huge.w, huge.h)).toBeLessThanOrEqual(4096);
    expect(huge.scale).toBeLessThan(8);
  });

  it('极小板仍产出合法画布', () => {
    const t = texSize(0.1, 0.1);
    expect(t.w).toBeGreaterThanOrEqual(2);
    expect(t.h).toBeGreaterThanOrEqual(2);
  });
});

/**
 * 器件 3D 摆位：Top/Bottom × 0/90/180/270 —— 3D 全视图与投影层共用同一实现
 */
import { describe, it, expect } from 'vitest';
import { componentPose, applyComponent3DTransform } from '../../src/modules/board-editor/component-3d-transform';
import { createDocument } from '../../src/design-core/document/factory';
import { searchResultToPlaced } from '../../src/design-core/document/services';
import type { ComponentSearchResult } from '../../src/providers/types';

const board = { ...createDocument({ name: 'b' }).board, widthMm: 100, heightMm: 80 };
const mk = (x: number, y: number, rot: number, side: 'TOP' | 'BOTTOM') => {
  const c = searchResultToPlaced({
    componentId: 'x', mpn: 'M', manufacturer: '-', category: 'ic',
    defaultFootprintName: 'SOIC-8_3.9x4.9mm_P1.27mm', family: 'IC', pins: 8,
  } as ComponentSearchResult, 'U1');
  c.placement.xMm = x; c.placement.yMm = y;
  c.placement.rotation = rot as 0 | 90 | 180 | 270;
  c.placement.side = side;
  return c;
};

describe('位置：板坐标 → 以板中心为原点的场景坐标', () => {
  it('板中心映射到场景原点', () => {
    const p = componentPose(mk(50, 40, 0, 'TOP'), board);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.z).toBeCloseTo(0, 9);
  });
  it('左上角映射到 (-W/2, -H/2)', () => {
    const p = componentPose(mk(0, 0, 0, 'TOP'), board);
    expect(p.x).toBeCloseTo(-50, 9);
    expect(p.z).toBeCloseTo(-40, 9);
  });
});

describe('旋转', () => {
  for (const rot of [0, 90, 180, 270]) {
    it(`TOP ${rot}°：绕 Y 轴正向旋转，不翻面`, () => {
      const p = componentPose(mk(10, 10, rot, 'TOP'), board);
      expect(p.rotX).toBe(0);
      expect(p.rotY).toBeCloseTo((rot * Math.PI) / 180, 9);
    });
    it(`BOTTOM ${rot}°：绕 X 轴翻 180°，板面内旋转取镜像`, () => {
      const p = componentPose(mk(10, 10, rot, 'BOTTOM'), board);
      expect(p.rotX).toBeCloseTo(Math.PI, 9);
      expect(p.rotY).toBeCloseTo(-(rot * Math.PI) / 180, 9);
    });
  }
});

describe('高度', () => {
  it('TOP 贴板面（y=0），BOTTOM 挂在板下方', () => {
    expect(componentPose(mk(0, 0, 0, 'TOP'), board, { boardThicknessMm: 1.6 }).y).toBeCloseTo(0, 9);
    expect(componentPose(mk(0, 0, 0, 'BOTTOM'), board, { boardThicknessMm: 1.6 }).y).toBeCloseTo(-1.6, 9);
  });
  it('zOffsetMm 架高：TOP 向上、BOTTOM 向下', () => {
    const top = mk(0, 0, 0, 'TOP'); top.display = { ...(top.display ?? {}), zOffsetMm: 2 };
    const bot = mk(0, 0, 0, 'BOTTOM'); bot.display = { ...(bot.display ?? {}), zOffsetMm: 2 };
    expect(componentPose(top, board).y).toBeCloseTo(2, 9);
    expect(componentPose(bot, board, { boardThicknessMm: 1.6 }).y).toBeCloseTo(-3.6, 9);
  });
});

describe('applyComponent3DTransform 写入对象', () => {
  it('只写 position/rotation', () => {
    const obj = { position: { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } }, rotation: { x: 0, y: 0 } };
    applyComponent3DTransform(obj, mk(20, 30, 90, 'BOTTOM'), board, { boardThicknessMm: 1.6 });
    expect(obj.position.x).toBeCloseTo(-30, 9);
    expect(obj.position.z).toBeCloseTo(-10, 9);
    expect(obj.rotation.x).toBeCloseTo(Math.PI, 9);
    expect(obj.rotation.y).toBeCloseTo(-Math.PI / 2, 9);
  });
});

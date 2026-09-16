/**
 * 选中框几何：基础层与 3D 叠加层必须完全一致（混合视图里出现过两个错位的框）
 */
import { describe, it, expect } from 'vitest';
import { selectionBoxPx } from '../../src/modules/board-editor/board-view-constants';
import { registerFootprintOverride } from '../../src/design-core/geometry/lib-file-registry';
import { searchResultToPlaced } from '../../src/design-core/document/services';
import { PX_PER_MM } from '../../src/design-core/geometry';
import type { ComponentSearchResult } from '../../src/providers/types';

registerFootprintOverride('TEST_HDR', {
  bodyW: 2.54, bodyH: 30.5,
  pads: Array.from({ length: 12 }, (_, i) => ({ x: 0, y: -13.97 + i * 2.54, w: 1.7, h: 1.7, num: String(i + 1), round: true })),
});

const mk = (x: number, y: number, rot: 0 | 90 | 180 | 270, side: 'TOP' | 'BOTTOM') => {
  const c = searchResultToPlaced({
    componentId: 'x', mpn: 'HDR-12', manufacturer: '-', category: 'connector',
    defaultFootprintName: 'TEST_HDR', family: 'Header', pins: 12,
  } as ComponentSearchResult, 'J1');
  c.placement.xMm = x; c.placement.yMm = y; c.placement.rotation = rot; c.placement.side = side;
  return c;
};

describe('选中框', () => {
  it('中心对齐器件位置（不是封装 body 的左上角）', () => {
    const b = selectionBoxPx(mk(20, 15, 0, 'TOP'))!;
    expect(b.cx).toBeCloseTo(60 + 20 * PX_PER_MM, 6);
    expect(b.cy).toBeCloseTo(40 + 15 * PX_PER_MM, 6);
  });

  it('尺寸覆盖焊盘外沿而不是只覆盖本体', () => {
    const b = selectionBoxPx(mk(20, 15, 0, 'TOP'))!;
    // 12 脚 2.54 间距：纵向跨度 ≈ 13.97*2 + 1.7 ≈ 29.6mm，加 8px 余量
    expect(b.h).toBeGreaterThan(29 * PX_PER_MM);
    expect(b.w).toBeGreaterThan(2.5 * PX_PER_MM);
  });

  it('旋转与镜像随器件（overlay 用同一变换即可对齐）', () => {
    expect(selectionBoxPx(mk(0, 0, 90, 'TOP'))!.rot).toBe(90);
    expect(selectionBoxPx(mk(0, 0, 0, 'BOTTOM'))!.mirror).toBe(true);
    expect(selectionBoxPx(mk(0, 0, 0, 'TOP'))!.mirror).toBe(false);
  });

  it('没有焊盘数据时退回本体尺寸，仍以器件为中心', () => {
    const c = searchResultToPlaced({
      componentId: 'y', mpn: 'X', manufacturer: '-', category: 'ic',
      defaultFootprintName: 'NO_SUCH_FOOTPRINT_XYZ', family: 'IC', pins: 2,
    } as ComponentSearchResult, 'U9');
    c.placement.xMm = 10; c.placement.yMm = 10;
    const b = selectionBoxPx(c)!;
    expect(b.x).toBeLessThan(0);
    expect(b.y).toBeLessThan(0);
    expect(b.w).toBeGreaterThan(0);
  });
});

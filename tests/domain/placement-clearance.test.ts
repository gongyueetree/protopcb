/**
 * 定位孔净空与拖放间距（KiCad 约定）
 */
import { describe, it, expect } from 'vitest';
import { findOverlaps, hitsMountingHole, resolveDropPosition, holeKeepouts, HOLE_CLEARANCE_MM } from '../../src/design-core/collision';
import { materializeMountingHoles } from '../../src/design-core/board/mounting-holes';
import { createDocument } from '../../src/design-core/document/factory';
import { searchResultToPlaced } from '../../src/design-core/document/services';
import type { PlacedComponent } from '../../src/design-core/document/types';

const board = () => {
  const d = createDocument({ name: 'b' });
  d.board.widthMm = 100; d.board.heightMm = 80; d.board.mountingHolesEnabled = true;
  materializeMountingHoles(d.board);
  return d.board;
};
const part = (ref: string, x: number, y: number, fp = 'SOIC-8_3.9x4.9mm_P1.27mm'): PlacedComponent => {
  const c = searchResultToPlaced({ componentId: 'k' + ref, mpn: 'M', manufacturer: '-', category: 'ic', defaultFootprintName: fp, family: 'IC', description: '', pins: 8 }, ref);
  c.placement.xMm = x; c.placement.yMm = y;
  return c;
};

describe('定位孔净空', () => {
  it('孔的禁布圆 = 孔径/2 + 净空', () => {
    const k = holeKeepouts(board());
    expect(k).toHaveLength(4);
    expect(k[0].r).toBeCloseTo(3.2 / 2 + HOLE_CLEARANCE_MM, 6);
  });
  it('压在孔上的器件被判冲突', () => {
    const b = board();
    expect(hitsMountingHole(part('U1', 4, 4), b)).toBe(true);     // 孔在 (4,4)
    expect(hitsMountingHole(part('U2', 50, 40), b)).toBe(false);
  });
  it('findOverlaps 传入 board 时把孔冲突算进去', () => {
    const b = board();
    const comps = [part('U1', 4, 4), part('U2', 50, 40)];
    expect(findOverlaps(comps)).not.toContain(comps[0].instanceId);              // 不传 board：只比器件
    expect([...findOverlaps(comps, undefined, b)]).toContain(comps[0].instanceId); // 传 board：孔冲突入列
  });
});

describe('拖放落点', () => {
  const b = board();
  it('空地直接落下，不推', () => {
    const r = resolveDropPosition(part('U1', 50, 40), 50, 40, [], b);
    expect(r).toMatchObject({ x: 50, y: 40, nudged: false, overlapping: false, rejected: false });
  });
  it('落到孔上 → 被推开，且推后不再压孔', () => {
    const t = part('U1', 50, 40);
    const r = resolveDropPosition(t, 4, 4, [], b);
    expect(r.nudged).toBe(true);
    expect(hitsMountingHole({ ...t, placement: { ...t.placement, xMm: r.x, yMm: r.y } }, b)).toBe(false);
  });
  it('落到别的器件上 → 轻推到附近满足间距的位置', () => {
    const other = part('U2', 50, 40);
    const r = resolveDropPosition(part('U1', 20, 20), 50, 40, [other], b);
    expect(r.nudged).toBe(true);
    expect(r.overlapping).toBe(false);
    expect(Math.hypot(r.x - 50, r.y - 40)).toBeLessThanOrEqual(12);   // 推开一个身位以内（半径按器件尺寸定）
  });
  it('大范围密集区推不开 → 允许落下并标记重叠（绝不阻止拖动）', () => {
    // 40×30mm 内铺满 0402，搜索半径内没有任何空位
    const crowd = Array.from({ length: 900 }, (_, i) => part('C' + i, 30 + (i % 30) * 1.2, 20 + Math.floor(i / 30) * 1.2, 'C_0402_1005Metric'));
    const r = resolveDropPosition(part('U9', 10, 10), 45, 33, crowd, b);
    expect(r.rejected).toBe(false);
    expect(r.overlapping).toBe(true);
  });

  it('稍挤但周边有空位 → 推到空位而不是硬叠上去', () => {
    const crowd = Array.from({ length: 60 }, (_, i) => part('C' + i, 40 + (i % 10) * 1.2, 30 + Math.floor(i / 10) * 1.2, 'C_0402_1005Metric'));
    const r = resolveDropPosition(part('U9', 10, 10), 45, 33, crowd, b);
    expect(r.nudged).toBe(true);
    expect(r.overlapping).toBe(false);
  });
  it('不同层的器件互不干扰', () => {
    const bottom = part('U2', 50, 40); bottom.placement.side = 'BOTTOM';
    const r = resolveDropPosition(part('U1', 20, 20), 50, 40, [bottom], b);
    expect(r.nudged).toBe(false);
  });
});

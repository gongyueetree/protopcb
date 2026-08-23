import { describe, it, expect } from 'vitest';
import { solvePlacementDetailed } from './index';
import { createBoard } from '../document/factory';
import type { PlacedComponent } from '../document/types';

const mk = (id: string, ref: string, w: number, h: number, x = 0, y = 0): PlacedComponent => ({
  instanceId: id, componentId: id, reference: ref, mpn: 'X', manufacturer: 'M',
  category: 'ic', source: 'MOCK',
  footprint: { footprintId: 'fp', name: 'fp', confidence: 1, geometry: {
    footprintId: 'fp', bodyWidthMm: w, bodyHeightMm: h,
    courtyardWidthMm: w, courtyardHeightMm: h, padCount: 2, rotationStep: 90, anchor: { x: 0, y: 0 },
  } },
  placement: { xMm: x, yMm: y, rotation: 0, side: 'TOP', locked: false },
} as PlacedComponent);

describe('放置求解的失败语义', () => {
  it('空板上正常放置：success=true 且无违规', () => {
    const board = createBoard();
    const out = solvePlacementDetailed(mk('a', 'U1', 10, 10), { board, existing: [], rules: [] });
    expect(out.success).toBe(true);
    expect(out.violations).toHaveLength(0);
  });

  it('板子塞满时明确报告 overlap，而不是静默返回一个坐标', () => {
    const board = { ...createBoard(), widthMm: 20, heightMm: 20 };
    // 用一个几乎占满板面的器件堵死空间
    const blocker = mk('b', 'U9', 19, 19, 10, 10);
    const out = solvePlacementDetailed(mk('a', 'U1', 15, 15), { board, existing: [blocker], rules: [] });
    expect(out.success).toBe(false);
    expect(out.violations.some((v) => v.kind === 'overlap' || v.kind === 'off_board')).toBe(true);
    expect(out.position).toBeTruthy();   // 仍给出「最不坏」位置供调用方决定
  });

  it('器件大于板框时报告 off_board', () => {
    const board = { ...createBoard(), widthMm: 10, heightMm: 10 };
    const out = solvePlacementDetailed(mk('a', 'U1', 40, 40), { board, existing: [], rules: [] });
    expect(out.success).toBe(false);
    expect(out.violations.map((v) => v.kind)).toContain('off_board');
  });

  it('压住定位孔时报告 mounting_hole', () => {
    const board = { ...createBoard(), widthMm: 30, heightMm: 30, mountingHolesEnabled: true };
    // 占满整板 → 必然覆盖四角定位孔
    const out = solvePlacementDetailed(mk('a', 'U1', 29, 29), { board, existing: [], rules: [] });
    expect(out.violations.some((v) => v.kind === 'mounting_hole' || v.kind === 'off_board')).toBe(true);
  });

  it('落入禁布区时报告 keepout（多边形按外接矩形判定）', () => {
    const board = {
      ...createBoard(), widthMm: 40, heightMm: 40, mountingHolesEnabled: false,
      keepoutZones: [{ id: 'kz1', label: '天线净空', polygon: [
        { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 },
      ] }],
    };
    const out = solvePlacementDetailed(mk('a', 'U1', 5, 5), { board, existing: [], rules: [] });
    expect(out.success).toBe(false);
    expect(out.violations.map((v) => v.kind)).toContain('keepout');
  });
});

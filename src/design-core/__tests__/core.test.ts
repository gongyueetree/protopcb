/**
 * design-core/__tests__/core.test.ts
 * 核心引擎单元测试：几何、碰撞、放置。
 */
import { describe, it, expect } from 'vitest';
import { rectsOverlap, pointInPolygon, footprintCourtyardRect, clampRectInside } from '../geometry';
import { findOverlaps, clampComponentToBoard } from '../collision';
import { autoPlaceAll } from '../placement';
import { createBoard } from '../document/factory';
import { searchResultToPlaced, nextReference, runDesignReview } from '../document/services';
import { createDocument } from '../document/factory';
import type { ComponentSearchResult } from '../../providers/types';
import { MOCK_COMPONENTS, LEGACY_PARTS } from '../../providers/mock/data';

const asResult = (id: string): ComponentSearchResult => {
  const c = [...MOCK_COMPONENTS, ...LEGACY_PARTS].find((x) => x.componentId === id)!;
  return { ...c, org: undefined };
};

describe('geometry', () => {
  it('rectsOverlap detects overlap', () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 })).toBe(false);
  });

  it('rotation swaps courtyard dimensions', () => {
    const g = { footprintId: 't', bodyWidthMm: 10, bodyHeightMm: 4, courtyardWidthMm: 12, courtyardHeightMm: 6, padCount: 2, rotationStep: 90, anchor: { x: 0, y: 0 } };
    const r0 = footprintCourtyardRect(g, { x: 0, y: 0 }, 0);
    const r90 = footprintCourtyardRect(g, { x: 0, y: 0 }, 90);
    expect(r0.width).toBe(12);
    expect(r90.width).toBe(6); // swapped
  });

  it('pointInPolygon works for L-shape', () => {
    const L = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 10 }];
    expect(pointInPolygon({ x: 2, y: 2 }, L)).toBe(true);
    expect(pointInPolygon({ x: 8, y: 8 }, L)).toBe(false); // in the cut-out
  });

  it('clampRectInside keeps rect within bounds', () => {
    const tl = clampRectInside({ x: 95, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 80 }, 2);
    expect(tl.x).toBeLessThanOrEqual(88);
  });
});

describe('placement engine', () => {
  it('auto-places without overlap', () => {
    const board = createBoard(100, 80);
    const ids = ['stm32f103', 'lm1117', 'usbc', 'ch340', 'cap100nf', 'res10k'];
    let placed = ids.map((id, i) => searchResultToPlaced(asResult(id), `X${i}`));
    placed = autoPlaceAll(placed, board);
    const overlaps = findOverlaps(placed);
    expect(overlaps.size).toBe(0);
  });

  it('connector goes near board edge', () => {
    const board = createBoard(100, 80);
    let placed = [searchResultToPlaced(asResult('usbc'), 'J1')];
    placed = autoPlaceAll(placed, board);
    const x = placed[0].placement.xMm;
    // USB rule = left edge → x should be small
    expect(x).toBeLessThan(30);
  });

  it('clampComponentToBoard keeps component on board', () => {
    const board = createBoard(100, 80);
    const c = searchResultToPlaced(asResult('stm32f103'), 'U1');
    c.placement.xMm = 999;
    c.placement.yMm = 999;
    const p = clampComponentToBoard(c, board);
    expect(p.x).toBeLessThanOrEqual(100);
    expect(p.y).toBeLessThanOrEqual(80);
  });
});

describe('design review', () => {
  it('flags missing MCU and power on empty-ish design', () => {
    const doc = createDocument();
    doc.components = [searchResultToPlaced(asResult('cap100nf'), 'C1')];
    const findings = runDesignReview(doc);
    const titles = findings.map((f) => f.title);
    expect(titles.some((t) => t.includes('主控'))).toBe(true);
    expect(titles.some((t) => t.includes('电源'))).toBe(true);
  });

  it('nextReference 按 KiCad 习惯编号', () => {
    const placed = [searchResultToPlaced(asResult('cap100nf'), 'C1')];
    // 电容按关键词 → C 序列递增
    expect(nextReference({ category: 'passive', mpn: 'CAP-1uF' }, placed)).toBe('C2');
    // 电阻按关键词 → R 序列独立起步
    expect(nextReference({ category: 'passive', mpn: 'RES-10KΩ' }, placed)).toBe('R1');
  });
});

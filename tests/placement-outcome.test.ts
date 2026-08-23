/**
 * 验收 12：密集 PCB 无合法位置时 placement 必须返回 failure/violation，不能 silent success
 * 附带：shape-aware 板框（圆板/L 型缺口）与真多边形禁布区判定
 */
import { describe, it, expect } from 'vitest';
import { solvePlacementDetailed, autoPlaceAllDetailed, pointInBoardShape, rectIntersectsPolygon, DEFAULT_PLACEMENT_RULES } from '../src/design-core/placement';
import { searchResultToPlaced } from '../src/design-core/document/services';
import { createDocument } from '../src/design-core/document/factory';
import type { ComponentSearchResult } from '../src/providers/types';
import type { PlacedComponent } from '../src/design-core/document/types';

const mk = (ref: string, fp = 'SOIC-8'): PlacedComponent => searchResultToPlaced({
  componentId: 'x_' + ref, mpn: 'X', manufacturer: 'Y', category: 'ic',
  defaultFootprintName: fp, family: 'IC', pins: 8,
} as ComponentSearchResult, ref);

describe('验收12：密集板放置失败必须显式', () => {
  it('小板塞不下时 success=false 且给出违规明细', () => {
    const doc = createDocument({ name: 'dense' });
    doc.board.widthMm = 12; doc.board.heightMm = 12;   // 极小板
    const existing: PlacedComponent[] = [];
    let sawFailure = false;
    for (let i = 0; i < 12; i++) {
      const c = mk('U' + i);
      const out = solvePlacementDetailed(c, { board: doc.board, existing, rules: DEFAULT_PLACEMENT_RULES });
      c.placement.xMm = out.position.x; c.placement.yMm = out.position.y;
      existing.push(c);
      if (!out.success) {
        sawFailure = true;
        expect(out.violations.length).toBeGreaterThan(0);
        expect(out.violations[0].detail).toBeTruthy();
      }
    }
    expect(sawFailure).toBe(true);   // 12 颗 SOIC-8 塞 12×12mm 必然失败
  });

  it('autoPlaceAllDetailed 汇报违规映射（不静默）', () => {
    const doc = createDocument({ name: 'dense2' });
    doc.board.widthMm = 10; doc.board.heightMm = 10;
    const comps = Array.from({ length: 10 }, (_, i) => mk('U' + i));
    const out = autoPlaceAllDetailed(comps, doc.board);
    expect(out.placed).toHaveLength(10);
    expect(Object.keys(out.violations).length).toBeGreaterThan(0);
  });

  it('宽松板上全部成功时违规映射为空', () => {
    const doc = createDocument({ name: 'roomy' });
    doc.board.widthMm = 120; doc.board.heightMm = 120;
    doc.board.mountingHolesEnabled = false;
    const out = autoPlaceAllDetailed([mk('U1'), mk('U2')], doc.board);
    expect(Object.keys(out.violations)).toHaveLength(0);
  });
});

describe('shape-aware 板框', () => {
  it('圆板：外接矩形角落在圆外 → off_board', () => {
    const doc = createDocument({ name: 'circ' });
    doc.board.shape = 'circle'; doc.board.widthMm = 30; doc.board.heightMm = 30;
    expect(pointInBoardShape({ x: 15, y: 15 }, doc.board)).toBe(true);   // 圆心
    expect(pointInBoardShape({ x: 1, y: 1 }, doc.board)).toBe(false);    // 方角（圆外）
  });

  it('L 型板：缺口区域不合法', () => {
    const doc = createDocument({ name: 'l' });
    doc.board.shape = 'lshape'; doc.board.widthMm = 60; doc.board.heightMm = 50;
    expect(pointInBoardShape({ x: 10, y: 10 }, doc.board)).toBe(true);
    expect(pointInBoardShape({ x: 59, y: 49 }, doc.board)).toBe(false);  // 右下缺口
  });

  it('禁布区真多边形相交：三角形外接矩形相交但实际不相交时不误报', () => {
    // 三角形 (0,0)(10,0)(0,10)；矩形在 (7,7)-(9,9)：bbox 相交、真实不相交
    const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    expect(rectIntersectsPolygon({ x: 7, y: 7, width: 2, height: 2 }, tri)).toBe(false);
    expect(rectIntersectsPolygon({ x: 1, y: 1, width: 2, height: 2 }, tri)).toBe(true);
  });
});

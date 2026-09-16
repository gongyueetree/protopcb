/**
 * 外壳协同：确定性几何回归
 * 所有断言都是可手算的几何关系 —— 这正是本功能不含 AI 推断的证明。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENCLOSURE, PCB_THICKNESS_MM, componentBodyHeight, heightEnvelope,
  computeEnclosureDims, checkEnclosure, buildEnclosureStl,
} from '../../src/design-core/enclosure';
import { createDocument } from '../../src/design-core/document/factory';
import { searchResultToPlaced } from '../../src/design-core/document/services';
import { registerFootprintOverride } from '../../src/design-core/geometry/lib-file-registry';
import type { ComponentSearchResult } from '../../src/providers/types';
import type { PlacedComponent } from '../../src/design-core/document/types';

const mk = (ref: string, fp: string, side: 'TOP' | 'BOTTOM' = 'TOP'): PlacedComponent => {
  const c = searchResultToPlaced({
    componentId: 'x_' + ref, mpn: 'M-' + ref, manufacturer: 'Y', category: 'ic',
    defaultFootprintName: fp, family: 'IC', pins: 8,
  } as ComponentSearchResult, ref);
  c.placement.side = side;
  return c;
};

describe('器件高度：datasheet 优先于估算', () => {
  it('封装带 heightMm（机械图提取）时直接采用，并标记 fromDatasheet', () => {
    registerFootprintOverride('TEST_TALL', { bodyW: 5, bodyH: 5, heightMm: 7.3, pads: [{ x: 0, y: 0, w: 1, h: 1, num: '1' }] });
    const h = componentBodyHeight('TEST_TALL');
    expect(h.bodyMm).toBe(7.3);
    expect(h.fromDatasheet).toBe(true);
  });

  it('无真实高度时按封装族估算并标记为非实测', () => {
    const h = componentBodyHeight('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');
    expect(h.fromDatasheet).toBe(false);
    expect(h.bodyMm).toBeGreaterThan(0);
  });

  it('用户架高 zOffsetMm 计入总高', () => {
    const c = mk('U1', 'TEST_TALL');
    c.display = { ...(c.display ?? {}), zOffsetMm: 2 };
    const env = heightEnvelope([c]);
    expect(env.topMaxMm).toBeCloseTo(9.3, 5);
  });
});

describe('外壳尺寸推导（可手算）', () => {
  it('外形 = 板尺寸 + 2×侧隙 + 2×壁厚；高度 = 支柱+板厚+器件+净空+壁+盖', () => {
    const doc = createDocument({ name: 'enc' });
    doc.board.widthMm = 50; doc.board.heightMm = 30;
    registerFootprintOverride('ENC_T', { bodyW: 4, bodyH: 4, heightMm: 5, pads: [{ x: 0, y: 0, w: 1, h: 1, num: '1' }] });
    const env = heightEnvelope([mk('U1', 'ENC_T')]);
    const spec = { ...DEFAULT_ENCLOSURE, wallMm: 2, sideClearanceMm: 1.5, standoffMm: 4, topClearanceMm: 2, lidMm: 2 };
    const d = computeEnclosureDims(doc.board, env, spec);
    expect(d.innerW).toBe(53);                    // 50 + 1.5*2
    expect(d.outerW).toBe(57);                    // 53 + 2*2
    expect(d.innerH).toBe(33);
    expect(d.innerDepth).toBeCloseTo(4 + PCB_THICKNESS_MM + 5 + 2, 5);
    expect(d.outerHeight).toBeCloseTo(d.innerDepth + 2 + 2, 5);
  });
});

describe('干涉检查', () => {
  it('底面高器件超过支柱净空 → error 且给出超出量', () => {
    const doc = createDocument({ name: 'enc2' });
    registerFootprintOverride('ENC_BOT', { bodyW: 4, bodyH: 4, heightMm: 6, pads: [{ x: 0, y: 0, w: 1, h: 1, num: '1' }] });
    doc.components = [mk('U2', 'ENC_BOT', 'BOTTOM')];
    const issues = checkEnclosure(doc, { ...DEFAULT_ENCLOSURE, standoffMm: 4, bottomClearanceMm: 1 });
    const err = issues.find((i) => i.code === 'bottom_clearance');
    expect(err).toBeDefined();
    expect(err!.level).toBe('error');
    expect(err!.message).toContain('6.0mm');
    expect(err!.message).toContain('3.0mm');   // 可用净空 4-1
    expect(err!.refs).toEqual(['U2']);
  });

  it('支柱足够高时不报冲突', () => {
    const doc = createDocument({ name: 'enc3' });
    doc.components = [mk('U2', 'ENC_BOT', 'BOTTOM')];
    const issues = checkEnclosure(doc, { ...DEFAULT_ENCLOSURE, standoffMm: 9, bottomClearanceMm: 1 });
    expect(issues.some((i) => i.code === 'bottom_clearance')).toBe(false);
  });

  it('壁厚/侧隙过小 → warn', () => {
    const doc = createDocument({ name: 'enc4' });
    const issues = checkEnclosure(doc, { ...DEFAULT_ENCLOSURE, wallMm: 0.6, sideClearanceMm: 0.1 });
    expect(issues.some((i) => i.code === 'wall_thin' && i.level === 'warn')).toBe(true);
    expect(issues.some((i) => i.code === 'side_clearance' && i.level === 'warn')).toBe(true);
  });

  it('估算高度必须显式告知（可信度前提）', () => {
    const doc = createDocument({ name: 'enc5' });
    doc.components = [mk('U1', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm')];
    const issues = checkEnclosure(doc, DEFAULT_ENCLOSURE);
    expect(issues.some((i) => i.code === 'estimated_height')).toBe(true);
  });

  it('超出板框的器件被标为需要外壳开口', () => {
    const doc = createDocument({ name: 'enc6' });
    doc.board.widthMm = 20; doc.board.heightMm = 20;
    const c = mk('J1', 'ENC_T');
    c.placement.xMm = 20; c.placement.yMm = 10;   // 半个本体在板外
    doc.components = [c];
    const issues = checkEnclosure(doc, DEFAULT_ENCLOSURE);
    const e = issues.find((i) => i.code === 'edge_component');
    expect(e).toBeDefined();
    expect(e!.refs).toContain('J1');
  });
});

describe('STL 导出', () => {
  it('生成合法 ASCII STL 且三角面法向齐全', () => {
    const doc = createDocument({ name: 'stl' });
    const env = heightEnvelope([]);
    const stl = buildEnclosureStl(doc.board, env, DEFAULT_ENCLOSURE, 'test_case');
    expect(stl.startsWith('solid test_case')).toBe(true);
    expect(stl.trimEnd().endsWith('endsolid test_case')).toBe(true);
    const facets = stl.match(/facet normal/g)?.length ?? 0;
    expect(facets).toBe(stl.match(/endfacet/g)?.length);
    expect(facets).toBeGreaterThanOrEqual(24);     // 外盒+内腔+顶环
    expect(stl).not.toMatch(/NaN|Infinity/);
  });
});

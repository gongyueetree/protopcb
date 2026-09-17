/**
 * 原理图首次显示要把内容带进视野。
 * 固定 pan(20,20)+zoom 1 只对 KiCad 成立（图纸坐标从左上角起、为正）；
 * Altium 的 Y 轴向上，翻转后坐标全为负，内容整个在视野上方 —— 页面一片空白。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAltiumSch } from '../../src/design-core/geometry/altium-sch-import';

/** 与 ImportedSchematicView 的自适应同一套算法 */
function fitView(
  pts: { x: number; y: number }[],
  viewW: number, viewH: number, pxmm: number,
): { zoom: number; pan: { x: number; y: number } } {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = (maxX - minX) * pxmm || 1, h = (maxY - minY) * pxmm || 1;
  const zoom = Math.min(1, Math.min((viewW * 0.92) / w, (viewH * 0.92) / h));
  return {
    zoom,
    pan: { x: (viewW - w * zoom) / 2 - minX * pxmm * zoom, y: (viewH - h * zoom) / 2 - minY * pxmm * zoom },
  };
}

const PXMM = 3.7795;
const visible = (p: { x: number; y: number }, fit: ReturnType<typeof fitView>, vw: number, vh: number) => {
  const sx = p.x * PXMM * fit.zoom + fit.pan.x;
  const sy = p.y * PXMM * fit.zoom + fit.pan.y;
  return sx >= -1 && sx <= vw + 1 && sy >= -1 && sy <= vh + 1;
};

describe('Altium 原理图（坐标为负）', () => {
  const sch = parseAltiumSch(new Uint8Array(readFileSync(
    fileURLToPath(new URL('../fixtures/altium-nano-debug.SchDoc', import.meta.url)))));
  const pts = [...sch.instances.map((i) => ({ x: i.x, y: i.y })),
    ...sch.wires.flat().map(([x, y]) => ({ x, y }))];

  it('内容确实在负坐标区（固定 pan 会看不见）', () => {
    expect(Math.max(...pts.map((p) => p.y))).toBeLessThan(0);
  });

  it('自适应后全部器件落在视野内', () => {
    const fit = fitView(pts, 1000, 700, PXMM);
    const outside = sch.instances.filter((i) => !visible(i, fit, 1000, 700));
    expect(outside).toEqual([]);
    expect(fit.zoom).toBeGreaterThan(0);
    expect(fit.zoom).toBeLessThanOrEqual(1);
  });

  it('不把小图强行放大（zoom 上限 1）', () => {
    const tiny = [{ x: 0, y: 0 }, { x: 5, y: 5 }];
    expect(fitView(tiny, 1000, 700, PXMM).zoom).toBe(1);
  });

  it('正坐标的 KiCad 图同样落在视野内', () => {
    const kicadLike = [{ x: 20, y: 20 }, { x: 250, y: 180 }];
    const fit = fitView(kicadLike, 1000, 700, PXMM);
    for (const p of kicadLike) expect(visible(p, fit, 1000, 700)).toBe(true);
  });
});

describe('视图组件接线', () => {
  it('ImportedSchematicView 挂了容器 ref 并在换页时重新自适应', async () => {
    const src = readFileSync(fileURLToPath(
      new URL('../../src/modules/schematic/ImportedSchematicView.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/ref=\{wrapRef\}/);
    expect(src).toMatch(/fittedRef\.current === currentFile/);
    expect(src).toMatch(/\}, \[sheet, currentFile\]\);/);
  });
});

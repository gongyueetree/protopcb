/**
 * 外壳开孔与固定方式：确定性推导 + CadQuery 脚本生成
 */
import { describe, it, expect } from 'vitest';
import { deriveOpenings, deriveMounting, bodyRectOf } from '../src/design-core/enclosure/openings';
import { buildCadQueryScript } from '../src/design-core/enclosure/cadquery';
import { DEFAULT_ENCLOSURE, PCB_THICKNESS_MM, heightEnvelope, computeEnclosureDims } from '../src/design-core/enclosure';
import { createDocument } from '../src/design-core/document/factory';
import { searchResultToPlaced } from '../src/design-core/document/services';
import { registerFootprintOverride } from '../src/design-core/geometry/lib-file-registry';
import type { ComponentSearchResult } from '../src/providers/types';
import type { CircuitCanvasDocument } from '../src/design-core/document/types';

registerFootprintOverride('TEST_USBC', { bodyW: 9, bodyH: 7.5, heightMm: 3.2, pads: [{ x: 0, y: 0, w: 1, h: 1, num: '1' }] });
registerFootprintOverride('TEST_OLED', { bodyW: 26, bodyH: 15, heightMm: 2.5, pads: [{ x: 0, y: 0, w: 1, h: 1, num: '1' }] });
registerFootprintOverride('TEST_SW', { bodyW: 6, bodyH: 6, heightMm: 5, pads: [{ x: 0, y: 0, w: 1, h: 1, num: '1' }] });
registerFootprintOverride('TEST_QFP', { bodyW: 7, bodyH: 7, heightMm: 1.6, pads: [{ x: 0, y: 0, w: 1, h: 1, num: '1' }] });

function place(doc: CircuitCanvasDocument, ref: string, fp: string, mpn: string, cat: string, x: number, y: number) {
  const c = searchResultToPlaced({
    componentId: 'x_' + ref, mpn, manufacturer: '—', category: cat,
    defaultFootprintName: fp, family: 'X', pins: 2,
  } as ComponentSearchResult, ref);
  c.placement.xMm = x; c.placement.yMm = y;
  doc.components.push(c);
  return c;
}

describe('侧壁开孔（对外连接器）', () => {
  it('板边 USB-C 在最近的那面墙上开孔，尺寸=本体+装配间隙', () => {
    const doc = createDocument({ name: 'enc' });
    doc.board.widthMm = 60; doc.board.heightMm = 40;
    place(doc, 'J1', 'TEST_USBC', 'USB-C-16P', 'connector', 4.5, 20);   // 紧贴左边
    const [o] = deriveOpenings(doc);
    expect(o.face).toBe('left');
    expect(o.shape).toBe('rect');
    expect(o.w).toBeCloseTo(7.5 + 1.0, 3);          // 沿左墙方向 = 本体 H
    expect(o.h).toBeCloseTo(3.2 + 1.0, 3);          // 高度 = 器件高 + 间隙
    expect(o.reference).toBe('J1');
  });

  it('本体越过板边同样开孔，理由注明"越过板边"', () => {
    const doc = createDocument({ name: 'enc' });
    doc.board.widthMm = 60; doc.board.heightMm = 40;
    place(doc, 'J1', 'TEST_USBC', 'USB-C', 'connector', 60, 20);        // 一半在板外
    const [o] = deriveOpenings(doc);
    expect(o.face).toBe('right');
    expect(o.reason).toMatch(/越过板边/);
  });

  it('板中央的连接器不开孔（够不到墙）', () => {
    const doc = createDocument({ name: 'enc' });
    doc.board.widthMm = 60; doc.board.heightMm = 40;
    place(doc, 'J2', 'TEST_USBC', 'HEADER', 'connector', 30, 20);
    expect(deriveOpenings(doc)).toHaveLength(0);
  });
});

describe('顶盖开窗/开孔', () => {
  it('显示屏按本体尺寸开矩形窗，不放大', () => {
    const doc = createDocument({ name: 'enc' });
    place(doc, 'U5', 'TEST_OLED', 'SSD1306', 'ic', 30, 20);
    const [o] = deriveOpenings(doc);
    expect(o.face).toBe('top');
    expect(o.shape).toBe('rect');
    expect(o.w).toBeCloseTo(26, 3);
    expect(o.h).toBeCloseTo(15, 3);
  });

  it('按键开圆孔，LED 开 Ø3 导光孔', () => {
    const doc = createDocument({ name: 'enc' });
    place(doc, 'SW1', 'TEST_SW', 'TACT-6X6', 'electromech', 20, 20);
    place(doc, 'D1', 'LED_0603_1608Metric', 'LED-GREEN', 'passive', 40, 20);
    const os = deriveOpenings(doc);
    const sw = os.find((o) => o.reference === 'SW1')!;
    const led = os.find((o) => o.reference === 'D1')!;
    expect(sw.shape).toBe('circle');
    expect(sw.w).toBeCloseTo(7, 3);
    expect(led.shape).toBe('circle');
    expect(led.w).toBe(3.0);
  });

  it('底面器件不在顶盖开孔', () => {
    const doc = createDocument({ name: 'enc' });
    const c = place(doc, 'D1', 'LED_0603_1608Metric', 'LED', 'passive', 20, 20);
    c.placement.side = 'BOTTOM';
    expect(deriveOpenings(doc)).toHaveLength(0);
  });

  it('普通 IC 不开孔（识别不出用途就不臆造）', () => {
    const doc = createDocument({ name: 'enc' });
    place(doc, 'U1', 'TEST_QFP', 'STM32F103C8T6', 'mcu', 30, 20);
    expect(deriveOpenings(doc)).toHaveLength(0);
  });
});

describe('固定方式', () => {
  it('有定位孔 → 螺柱，柱位即孔位', () => {
    const doc = createDocument({ name: 'enc' });
    doc.board.mountingHoles = [
      { position: { x: 3, y: 3 }, diameterMm: 2.7 },
      { position: { x: 57, y: 37 }, diameterMm: 2.7 },
    ];
    const m = deriveMounting(doc.board);
    expect(m.kind).toBe('screw-post');
    expect(m.positions).toEqual([{ x: 3, y: 3 }, { x: 57, y: 37 }]);
    expect(m.detail).toMatch(/2.7/);
  });

  it('无定位孔 → 卡扣，沿长边各 2 处', () => {
    const doc = createDocument({ name: 'enc' });
    doc.board.widthMm = 80; doc.board.heightMm = 40;
    const m = deriveMounting(doc.board);
    expect(m.kind).toBe('snap-fit');
    expect(m.positions).toHaveLength(4);
    expect(m.positions.every((p) => p.y === 0 || p.y === 40)).toBe(true);   // 长边在 X 方向
  });
});

describe('CadQuery 脚本', () => {
  it('包含参数、开孔与导出语句，且每个开孔带来源位号注释', () => {
    const doc = createDocument({ name: 'demo' });
    doc.board.widthMm = 60; doc.board.heightMm = 40;
    place(doc, 'J1', 'TEST_USBC', 'USB-C-16P', 'connector', 4.5, 20);
    place(doc, 'U5', 'TEST_OLED', 'SSD1306', 'ic', 30, 20);
    const env = heightEnvelope(doc.components);
    const py = buildCadQueryScript({
      name: 'demo', spec: DEFAULT_ENCLOSURE, dims: computeEnclosureDims(doc.board, env, DEFAULT_ENCLOSURE),
      openings: deriveOpenings(doc), mounting: deriveMounting(doc.board),
      board: doc.board, pcbThicknessMm: PCB_THICKNESS_MM,
    });
    expect(py).toContain('import cadquery as cq');
    expect(py).toContain('OUTER_W =');
    expect(py).toContain('cutThruAll');
    expect(py).toContain('# J1');
    expect(py).toContain('# U5');
    expect(py).toContain('demo-bottom.step');
    expect(py).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('无开孔时脚本依然完整可运行', () => {
    const doc = createDocument({ name: 'plain' });
    const env = heightEnvelope([]);
    const py = buildCadQueryScript({
      name: 'plain', spec: DEFAULT_ENCLOSURE, dims: computeEnclosureDims(doc.board, env, DEFAULT_ENCLOSURE),
      openings: [], mounting: deriveMounting(doc.board), board: doc.board, pcbThicknessMm: PCB_THICKNESS_MM,
    });
    expect(py).toContain('cq.exporters.export');
    expect(py).not.toContain('cutThruAll');
  });
});

describe('本体包围盒', () => {
  it('旋转 90° 时长宽互换', () => {
    const doc = createDocument({ name: 'r' });
    const c = place(doc, 'J1', 'TEST_USBC', 'USB-C', 'connector', 30, 20);
    const a = bodyRectOf(c);
    c.placement.rotation = 90;
    const b = bodyRectOf(c);
    expect(b.w).toBeCloseTo(a.h, 5);
    expect(b.h).toBeCloseTo(a.w, 5);
  });
});

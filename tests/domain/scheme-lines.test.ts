/**
 * Phase 13：方案行不复制对象，只在 Apply 时展开
 */
import { describe, it, expect } from 'vitest';
import { toSchemeLines, materializeSchemeLines, removeSchemeLine, totalQty } from '../../src/design-core/scheme-lines';

const cap = { componentId: 'fp_C_100nF', mpn: '100nF', qty: 4, group: 'ESP32' };
const res = { componentId: 'fp_R_10k', mpn: '10k', qty: 2, group: 'ESP32' };
const mcu = { componentId: 'ez_ESP32', mpn: 'ESP32-S3', qty: 1, group: 'ESP32', core: true };

describe('评审阶段', () => {
  it('qty=4 仍是一行，不是四个相同引用', () => {
    const lines = toSchemeLines([cap, res, mcu]);
    expect(lines).toHaveLength(3);
    expect(lines[0].qty).toBe(4);
    expect(totalQty(lines)).toBe(7);
  });
  it('删除一行只删这一行，同型号不连坐', () => {
    const lines = toSchemeLines([cap, { ...cap, qty: 1 }, mcu]);   // 两行同型号（不同用途）
    const after = removeSchemeLine(lines, lines[0].lineId);
    expect(after).toHaveLength(2);
    expect(after.some((l) => l.component.componentId === 'fp_C_100nF')).toBe(true);
  });
  it('每行 lineId 唯一', () => {
    const ids = toSchemeLines([cap, cap, cap]).map((l) => l.lineId);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('Apply / Materialize', () => {
  it('展开为 qty 个独立副本（不是同一引用）', () => {
    const out = materializeSchemeLines(toSchemeLines([cap, res]));
    expect(out).toHaveLength(6);
    expect(out[0]).not.toBe(out[1]);
    expect(out[0]).toEqual(out[1]);
  });
  it('展开后 placeScheme 分配唯一位号（C1..C4）与 instanceId', async () => {
    const { useDesignStore } = await import('../../src/state/designStore');
    const ds = useDesignStore.getState();
    ds.clearAll();
    const items = materializeSchemeLines(toSchemeLines([
      { componentId: 'fp_C_100nF', mpn: '100nF', manufacturer: '-', category: 'passive', defaultFootprintName: 'C_0402_1005Metric', family: 'C', description: '', pins: 2, qty: 4 },
    ] as never[]));
    ds.placeScheme(items as never);
    const comps = useDesignStore.getState().doc.components;
    expect(comps).toHaveLength(4);
    expect(new Set(comps.map((c) => c.reference)).size).toBe(4);
    expect(new Set(comps.map((c) => c.instanceId)).size).toBe(4);
  });
});

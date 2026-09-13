/**
 * 子电路成组：跟随移动、整组删除、重排附属器件
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useDesignStore } from '../src/state/designStore';
import type { ComponentSearchResult } from '../src/providers/types';

const core = (): ComponentSearchResult => ({
  componentId: 'ez_u1', mpn: 'STM32F103C8T6', manufacturer: 'ST', category: 'mcu',
  defaultFootprintName: 'LQFP-48_7x7mm_P0.5mm', family: 'MCU', pins: 48,
} as ComponentSearchResult);

function setup() {
  const st = useDesignStore.getState();
  st.clearAll();
  st.addComponent(core());
  const u1 = useDesignStore.getState().doc.components[0];
  st.placeSubCircuit(u1.instanceId, [
    { role: '去耦电容', value: '100nF', category: 'passive', footprint: 'C_0402_1005Metric', connectsTo: 'VDD', qty: 3 },
    { role: '复位上拉', value: '10k', category: 'passive', footprint: 'R_0402_1005Metric', connectsTo: 'NRST', qty: 1 },
  ]);
  return useDesignStore.getState().doc.components.find((c) => c.instanceId === u1.instanceId)!;
}

describe('子电路成组', () => {
  beforeEach(() => { useDesignStore.getState().clearAll(); });

  it('附属器件带 anchorRef 指向核心位号', () => {
    const u1 = setup();
    const sats = useDesignStore.getState().doc.components.filter((c) => c.display?.anchorRef === u1.reference);
    expect(sats).toHaveLength(4);
  });

  it('groupMemberIds 从核心或任一附属件都能取到整组', () => {
    const u1 = setup();
    const st = useDesignStore.getState();
    const fromCore = st.groupMemberIds(u1.instanceId);
    expect(fromCore).toHaveLength(5);
    const anySat = st.doc.components.find((c) => c.display?.anchorRef === u1.reference)!;
    expect(new Set(st.groupMemberIds(anySat.instanceId))).toEqual(new Set(fromCore));
  });

  it('移动核心器件时附属器件按相同位移跟随', () => {
    const u1 = setup();
    const before = useDesignStore.getState().doc.components
      .filter((c) => c.display?.anchorRef === u1.reference)
      .map((c) => ({ id: c.instanceId, x: c.placement.xMm, y: c.placement.yMm }));
    const dx = 8, dy = 6;
    useDesignStore.getState().moveComponent(u1.instanceId, u1.placement.xMm + dx, u1.placement.yMm + dy);
    const after = useDesignStore.getState().doc.components;
    for (const b of before) {
      const a = after.find((c) => c.instanceId === b.id)!;
      expect(a.placement.xMm).toBeCloseTo(b.x + dx, 3);
      expect(a.placement.yMm).toBeCloseTo(b.y + dy, 3);
    }
  });

  it('删除核心器件时附属器件一并删除', () => {
    const u1 = setup();
    expect(useDesignStore.getState().doc.components).toHaveLength(5);
    useDesignStore.getState().removeComponent(u1.instanceId);
    expect(useDesignStore.getState().doc.components).toHaveLength(0);
  });

  it('删除单个附属器件不影响核心与其它附属件', () => {
    const u1 = setup();
    const sat = useDesignStore.getState().doc.components.find((c) => c.display?.anchorRef === u1.reference)!;
    useDesignStore.getState().removeComponent(sat.instanceId);
    expect(useDesignStore.getState().doc.components).toHaveLength(4);
  });

  it('重排附属器件：全部被重新放置且不产生重叠', () => {
    const u1 = setup();
    const r = useDesignStore.getState().reoptimizeGroup(u1.instanceId);
    expect(r.moved).toBe(4);
    expect(useDesignStore.getState().overlaps.size).toBe(0);
  });

  it('重排不移动核心器件本身', () => {
    const u1 = setup();
    const before = { x: u1.placement.xMm, y: u1.placement.yMm };
    useDesignStore.getState().reoptimizeGroup(u1.instanceId);
    const after = useDesignStore.getState().doc.components.find((c) => c.instanceId === u1.instanceId)!;
    expect(after.placement.xMm).toBeCloseTo(before.x, 5);
    expect(after.placement.yMm).toBeCloseTo(before.y, 5);
  });
});

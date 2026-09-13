/**
 * 原理图层级块：分组与折叠语义（纯逻辑，与渲染无关）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useDesignStore } from '../src/state/designStore';
import type { ComponentSearchResult } from '../src/providers/types';
import type { PlacedComponent } from '../src/design-core/document/types';

const core = (mpn: string, cat: string): ComponentSearchResult => ({
  componentId: 'ez_' + mpn, mpn, manufacturer: '—', category: cat,
  defaultFootprintName: 'LQFP-48_7x7mm_P0.5mm', family: 'IC', pins: 48,
} as ComponentSearchResult);

/** 复刻 SchematicPanel 的分块规则：核心 = 无 anchorRef 且被别人指向 */
function computeBlocks(comps: PlacedComponent[]) {
  const byCore = new Map<string, string[]>();
  for (const c of comps) {
    const ref = c.display?.anchorRef;
    if (!ref) continue;
    const coreExists = comps.some((x) => x.reference === ref && !x.display?.anchorRef);
    if (!coreExists) continue;
    byCore.set(ref, [...(byCore.get(ref) ?? []), c.reference]);
  }
  return [...byCore.entries()].map(([ref, members]) => ({ ref, members }));
}

describe('层级块分组', () => {
  beforeEach(() => useDesignStore.getState().clearAll());

  it('每个带子电路的核心器件成一个块', () => {
    const st = useDesignStore.getState();
    st.addComponent(core('STM32F103C8T6', 'mcu'));
    st.addComponent(core('AMS1117-3.3', 'power'));
    const [u1, u2] = useDesignStore.getState().doc.components;
    st.placeSubCircuit(u1.instanceId, [
      { role: '去耦', value: '100nF', category: 'passive', footprint: 'C_0402_1005Metric', connectsTo: 'VDD', qty: 2 },
    ]);
    st.placeSubCircuit(u2.instanceId, [
      { role: '输出电容', value: '10uF', category: 'passive', footprint: 'C_0805_2012Metric', connectsTo: 'VOUT', qty: 1 },
    ]);
    const blocks = computeBlocks(useDesignStore.getState().doc.components);
    expect(blocks).toHaveLength(2);
    expect(blocks.find((b) => b.ref === u1.reference)!.members).toHaveLength(2);
    expect(blocks.find((b) => b.ref === u2.reference)!.members).toHaveLength(1);
  });

  it('没有子电路的器件不成块（单个器件不必框起来）', () => {
    const st = useDesignStore.getState();
    st.addComponent(core('STM32F103C8T6', 'mcu'));
    expect(computeBlocks(useDesignStore.getState().doc.components)).toHaveLength(0);
  });

  it('附属器件不会自己再成一个块（不嵌套）', () => {
    const st = useDesignStore.getState();
    st.addComponent(core('STM32F103C8T6', 'mcu'));
    const u1 = useDesignStore.getState().doc.components[0];
    st.placeSubCircuit(u1.instanceId, [
      { role: '去耦', value: '100nF', category: 'passive', footprint: 'C_0402_1005Metric', connectsTo: 'VDD', qty: 1 },
    ]);
    const comps = useDesignStore.getState().doc.components;
    const sat = comps.find((c) => c.display?.anchorRef === u1.reference)!;
    // 附属件本身没有指向它的成员 → 不构成块
    expect(computeBlocks(comps).some((b) => b.ref === sat.reference)).toBe(false);
  });

  it('删除核心器件后对应的块随之消失', () => {
    const st = useDesignStore.getState();
    st.addComponent(core('STM32F103C8T6', 'mcu'));
    const u1 = useDesignStore.getState().doc.components[0];
    st.placeSubCircuit(u1.instanceId, [
      { role: '去耦', value: '100nF', category: 'passive', footprint: 'C_0402_1005Metric', connectsTo: 'VDD', qty: 1 },
    ]);
    expect(computeBlocks(useDesignStore.getState().doc.components)).toHaveLength(1);
    useDesignStore.getState().removeComponent(u1.instanceId);
    expect(computeBlocks(useDesignStore.getState().doc.components)).toHaveLength(0);
  });
});

/**
 * 框图重复生成（测评报告）：两种生成方式互斥，用户手动块保留
 */
import { describe, it, expect } from 'vitest';
import { useDesignStore } from '../../src/state/designStore';
import { blocksFromNetlist, layoutNetBlocks } from '../../src/design-core/block-diagram/from-netlist';
import type { ComponentSearchResult } from '../../src/providers/types';

const part = (mpn: string, cat: string): ComponentSearchResult => ({
  componentId: 'ez_' + mpn, mpn, manufacturer: '-', category: cat as ComponentSearchResult['category'],
  defaultFootprintName: 'SOIC-8_3.9x4.9mm_P1.27mm', family: 'IC', description: '', pins: 8,
} as ComponentSearchResult);

const seed = () => {
  const ds = useDesignStore.getState();
  ds.clearAll();
  ds.addComponent(part('STM32F103C8T6', 'mcu'));
  ds.addComponent(part('AMS1117-3.3', 'power'));
  ds.addComponent(part('USB-C-16P', 'connector'));
};

describe('两种生成方式互斥', () => {
  it('按网表生成后再按类别生成，不叠加（块数 = 类别数）', () => {
    seed();
    const doc = useDesignStore.getState().doc;
    const { blocks: nb } = blocksFromNetlist(doc);
    const pos = layoutNetBlocks(nb);
    useDesignStore.getState().setFunctionalBlocks(nb.map((b) => ({
      id: b.id, label: b.label, sublabel: b.sublabel, shape: 'rounded' as const,
      x: pos[b.id].x, y: pos[b.id].y, w: 150, h: 68, color: '#4b5563',
      componentIds: b.componentIds, generated: 'netlist' as const,
    })));
    expect(useDesignStore.getState().doc.functionalBlocks.length).toBeGreaterThan(0);

    useDesignStore.getState().generateBlocksFromComponents();
    const after = useDesignStore.getState().doc.functionalBlocks;
    expect(after.every((b) => b.generated === 'category')).toBe(true);
    expect(after).toHaveLength(3);                       // mcu / power / connector 各一个
    expect(after.some((b) => b.generated === 'netlist')).toBe(false);
  });

  it('用户手动添加的块（无 generated 标记）在重新生成后保留', () => {
    seed();
    const ds = useDesignStore.getState();
    ds.generateBlocksFromComponents();
    const withManual = [...useDesignStore.getState().doc.functionalBlocks,
      { id: 'my_note', label: '手工块', sublabel: '', shape: 'rect' as const, x: 10, y: 10, w: 100, h: 50, color: '#333', componentIds: [] }];
    ds.setFunctionalBlocks(withManual);
    ds.generateBlocksFromComponents();
    const after = useDesignStore.getState().doc.functionalBlocks;
    expect(after.some((b) => b.id === 'my_note')).toBe(true);
    expect(after.filter((b) => b.generated === 'category')).toHaveLength(3);
  });
});

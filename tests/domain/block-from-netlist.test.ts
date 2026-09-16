/**
 * 按真实网表生成功能框图
 */
import { describe, it, expect } from 'vitest';
import { blocksFromNetlist, layoutNetBlocks } from '../../src/design-core/block-diagram/from-netlist';
import { createDocument } from '../../src/design-core/document/factory';
import { searchResultToPlaced } from '../../src/design-core/document/services';
import type { ComponentSearchResult } from '../../src/providers/types';
import type { CircuitCanvasDocument } from '../../src/design-core/document/types';

function add(doc: CircuitCanvasDocument, ref: string, mpn: string, cat: string, padNets: Record<string, number>) {
  const c = searchResultToPlaced({
    componentId: 'x_' + ref, mpn, manufacturer: '—', category: cat,
    defaultFootprintName: 'SOT-23-5', family: 'X', pins: 5,
  } as ComponentSearchResult, ref);
  c.display = { ...(c.display ?? {}), padNets };
  doc.components.push(c);
  return c;
}

function board() {
  const doc = createDocument({ name: 'nb' });
  doc.nets = { '1': 'GND', '2': '+3V3', '3': '/SPI_CLK', '4': '/USB_DP' };
  add(doc, 'U1', 'STM32F103C8T6', 'mcu', { '1': 2, '2': 1, '3': 3, '4': 4 });
  add(doc, 'U2', 'AMS1117-3.3', 'power', { '1': 2, '2': 1 });
  add(doc, 'U3', 'W25Q32', 'ic', { '1': 3, '2': 1, '3': 2 });
  add(doc, 'J1', 'USB-C', 'connector', { '1': 4, '2': 1 });
  add(doc, 'C1', '100nF', 'passive', { '1': 2, '2': 1 });
  return doc;
}

describe('功能块', () => {
  it('每颗核心器件一个块，无源件不单独成块', () => {
    const { blocks } = blocksFromNetlist(board());
    expect(blocks.map((b) => b.sublabel).sort()).toEqual(['J1', 'U1', 'U2', 'U3']);
  });

  it('块类型按器件识别：主控/电源/接口/功能', () => {
    const { blocks } = blocksFromNetlist(board());
    expect(blocks.find((b) => b.sublabel === 'U1')!.kind).toBe('mcu');
    expect(blocks.find((b) => b.sublabel === 'U2')!.kind).toBe('power');
    expect(blocks.find((b) => b.sublabel === 'J1')!.kind).toBe('interface');
    expect(blocks.find((b) => b.sublabel === 'U3')!.kind).toBe('ic');
  });

  it('无源件归到共享信号网络最多的块（电源/地不作为归属依据）', () => {
    const doc = board();
    const { blocks } = blocksFromNetlist(doc);
    // C1 只接 +3V3/GND（都是电源网络）→ 不强行归属
    const owners = blocks.filter((b) => b.componentIds.length > 1);
    expect(owners).toHaveLength(0);
  });

  it('子电路 anchorRef 优先决定归属', () => {
    const doc = board();
    const c1 = doc.components.find((c) => c.reference === 'C1')!;
    c1.display = { ...(c1.display ?? {}), anchorRef: 'U1' };
    const { blocks } = blocksFromNetlist(doc);
    expect(blocks.find((b) => b.sublabel === 'U1')!.componentIds).toHaveLength(2);
  });
});

describe('块间连线', () => {
  it('共享信号网络 → 信号连线，标签为网络名', () => {
    const { blocks, links } = blocksFromNetlist(board());
    const u1 = blocks.find((b) => b.sublabel === 'U1')!.id;
    const u3 = blocks.find((b) => b.sublabel === 'U3')!.id;
    const l = links.find((x) => (x.from === u1 && x.to === u3) || (x.from === u3 && x.to === u1))!;
    expect(l.kind).toBe('signal');
    expect(l.label).toContain('/SPI_CLK');
  });

  it('电源网络只从电源块发出，不画成满屏网状', () => {
    const { blocks, links } = blocksFromNetlist(board());
    const pwr = blocks.find((b) => b.kind === 'power')!.id;
    const powerLinks = links.filter((l) => l.kind === 'power');
    expect(powerLinks.length).toBeGreaterThan(0);
    expect(powerLinks.every((l) => l.from === pwr)).toBe(true);
    // 非电源块之间不因为共用 GND 而互连
    const u1 = blocks.find((b) => b.sublabel === 'U1')!.id;
    const j1 = blocks.find((b) => b.sublabel === 'J1')!.id;
    expect(links.some((l) => l.kind === 'power' && ((l.from === u1 && l.to === j1) || (l.from === j1 && l.to === u1)))).toBe(false);
  });

  it('没有 netlist 时只出块不出连线（不臆造连接）', () => {
    const doc = createDocument({ name: 'plain' });
    add(doc, 'U1', 'STM32', 'mcu', {});
    add(doc, 'U2', 'LDO', 'power', {});
    const { blocks, links } = blocksFromNetlist(doc);
    expect(blocks).toHaveLength(2);
    expect(links).toHaveLength(0);
  });
});

describe('排布', () => {
  it('按 接口→电源→主控→功能 分列', () => {
    const { blocks } = blocksFromNetlist(board());
    const pos = layoutNetBlocks(blocks);
    const x = (ref: string) => pos[blocks.find((b) => b.sublabel === ref)!.id].x;
    expect(x('J1')).toBeLessThan(x('U2'));
    expect(x('U2')).toBeLessThan(x('U1'));
    expect(x('U1')).toBeLessThan(x('U3'));
  });
});

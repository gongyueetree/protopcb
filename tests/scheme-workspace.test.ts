/**
 * 方案工作台：分组、框图推导、版本 diff
 */
import { describe, it, expect } from 'vitest';
import { groupSchemeItems, deriveBlocks, diffSchemes, type SchemeItem } from '../src/design-core/scheme-workspace';

const it2 = (mpn: string, category: string, group?: string, core?: boolean): SchemeItem =>
  ({ componentId: 'x' + mpn + Math.random(), mpn, category, group, core });

describe('按核心器件分组', () => {
  const items = [
    it2('STM32C011F4P6', 'mcu', 'STM32C011F4P6', true),
    it2('CC0402KRX7R9BB104', 'passive', 'STM32C011F4P6'),
    it2('CC0402KRX7R9BB104', 'passive', 'STM32C011F4P6'),
    it2('AMS1117-3.3', 'power', 'AMS1117-3.3', true),
    it2('C0805C106K8PAC', 'passive', 'AMS1117-3.3'),
    it2('USB-C-16P', 'connector'),           // 未分组
  ];

  it('核心器件与附属器件归入同一组', () => {
    const gs = groupSchemeItems(items);
    const mcu = gs.find((g) => g.name === 'STM32C011F4P6')!;
    expect(mcu.core?.mpn).toBe('STM32C011F4P6');
    expect(mcu.satellites).toHaveLength(2);
  });

  it('主控组排在电源组之前，未分组的自成一组', () => {
    const gs = groupSchemeItems(items);
    expect(gs[0].core?.category).toBe('mcu');
    expect(gs[1].core?.category).toBe('power');
    expect(gs.some((g) => g.name === 'connector')).toBe(true);
  });

  it('模型没标 core 时取组内首个非无源器件', () => {
    const gs = groupSchemeItems([
      it2('C1', 'passive', 'G1'),
      it2('LM358', 'ic', 'G1'),
    ]);
    expect(gs[0].core?.mpn).toBe('LM358');
    expect(gs[0].satellites[0].mpn).toBe('C1');
  });
});

describe('框图推导（模型未给框图时）', () => {
  const gs = groupSchemeItems([
    it2('STM32C011F4P6', 'mcu', 'MCU', true),
    it2('AMS1117-3.3', 'power', 'PWR', true),
    it2('SHT40', 'sensor', 'SENSOR', true),
  ]);
  const { blocks, links } = deriveBlocks(gs);

  it('每组一个块，kind 按核心器件类别', () => {
    expect(blocks).toHaveLength(3);
    expect(blocks.find((b) => b.core === 'STM32C011F4P6')!.kind).toBe('mcu');
    expect(blocks.find((b) => b.core === 'SHT40')!.kind).toBe('sensor');
  });

  it('电源连所有块，主控连所有非电源块 —— 不臆造总线名', () => {
    const pwr = blocks.find((b) => b.kind === 'power')!;
    const mcu = blocks.find((b) => b.kind === 'mcu')!;
    expect(links.filter((l) => l.from === pwr.id && l.kind === 'power')).toHaveLength(2);
    expect(links.filter((l) => l.from === mcu.id && l.kind === 'signal')).toHaveLength(1);
    expect(links.every((l) => l.label === undefined)).toBe(true);
  });
});

describe('版本 diff（AI 已完成修改清单的数据源）', () => {
  const v1 = [it2('STM32C011F4P6', 'mcu'), it2('SSD1306', 'ic'), it2('R10K', 'passive'), it2('R10K', 'passive')];

  it('识别新增/移除/数量变化', () => {
    const v2 = [it2('STM32C011F4P6', 'mcu'), it2('R10K', 'passive'), it2('TJA1050', 'ic')];
    const d = diffSchemes(v1, v2);
    expect(d.find((x) => x.kind === 'added')!.mpn).toBe('TJA1050');
    expect(d.find((x) => x.kind === 'removed')!.mpn).toBe('SSD1306');
    expect(d.find((x) => x.kind === 'qty')!.detail).toMatch(/2 → 1/);
  });

  it('无变化时返回空清单', () => {
    expect(diffSchemes(v1, v1.map((x) => ({ ...x })))).toHaveLength(0);
  });

  it('归组变化也被记录', () => {
    const a = [it2('C1', 'passive', 'G1')];
    const b = [it2('C1', 'passive', 'G2')];
    expect(diffSchemes(a, b).find((x) => x.kind === 'group')!.detail).toMatch(/G1 → G2/);
  });

  it('型号大小写/分隔符差异不算变化', () => {
    expect(diffSchemes([it2('AMS1117-3.3', 'power')], [it2('ams1117 3.3', 'power')])).toHaveLength(0);
  });
});

describe('同型号多只归并（核心件不再出现在列表中间）', () => {
  it('qty 展开的重复对象按 componentId 归并，counts 记录数量', () => {
    const core = it2('ESP32-S3-WROOM-1', 'rf', 'ESP32', true);
    const cap = it2('CC0402KRX7R9BB104', 'passive', 'ESP32');
    const res = it2('RC0402FR-0710KL', 'passive', 'ESP32');
    // 模拟 qty 展开：同一个对象被 push 多次
    const gs = groupSchemeItems([cap, cap, res, res, res, core]);
    const g = gs.find((x) => x.name === 'ESP32')!;
    expect(g.core?.mpn).toBe('ESP32-S3-WROOM-1');
    expect(g.satellites).toHaveLength(2);                       // 两种附属件
    expect(g.counts[cap.componentId]).toBe(2);
    expect(g.counts[res.componentId]).toBe(3);
  });

  it('核心器件不出现在 satellites 里（按 componentId 排除，不只按引用）', () => {
    const core = it2('STM32F103C8T6', 'mcu', 'MCU', true);
    const gs = groupSchemeItems([core, core, it2('C1', 'passive', 'MCU')]);
    const g = gs[0];
    expect(g.satellites.some((x) => x.componentId === core.componentId)).toBe(false);
    expect(g.counts[core.componentId]).toBe(2);
  });

  it('未分组的类别组同样归并', () => {
    const j = it2('USB-C-16P', 'connector');
    const gs = groupSchemeItems([j, j, j]);
    expect(gs[0].counts[j.componentId]).toBe(3);
    expect(gs[0].satellites).toHaveLength(0);                   // 只有一种，且已作为核心
  });
});

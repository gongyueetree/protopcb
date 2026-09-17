/**
 * 通用无源件查询：Cap / Res 缩写、值、值+封装（测评报告第 7 条）
 */
import { describe, it, expect } from 'vitest';
import { parseGenericPartQuery } from '../../src/design-core/semantics/generic-part-query';

describe('识别通用件查询', () => {
  it('缩写：Cap / Res / 电容 / 电阻', () => {
    expect(parseGenericPartQuery('Cap')).toMatchObject({ kind: 'capacitor', symbol: 'Device:C_Small' });
    expect(parseGenericPartQuery('res')).toMatchObject({ kind: 'resistor', symbol: 'Device:R_Small' });
    expect(parseGenericPartQuery('电容')).toMatchObject({ kind: 'capacitor' });
    expect(parseGenericPartQuery('电阻')).toMatchObject({ kind: 'resistor' });
  });
  it('纯值：100nF / 10k / 22uH', () => {
    expect(parseGenericPartQuery('100nF')).toMatchObject({ kind: 'capacitor', value: '100nF' });
    expect(parseGenericPartQuery('10k')).toMatchObject({ kind: 'resistor' });
    expect(parseGenericPartQuery('22uH')).toMatchObject({ kind: 'inductor', value: '22uH' });
  });
  it('值 + 封装：给出对应尺寸的 KiCad 官方封装', () => {
    expect(parseGenericPartQuery('100nF 0402')).toMatchObject({ footprint: 'C_0402_1005Metric', value: '100nF' });
    expect(parseGenericPartQuery('10k 0603')).toMatchObject({ footprint: 'R_0603_1608Metric' });
    expect(parseGenericPartQuery('Cap 0805')).toMatchObject({ footprint: 'C_0805_2012Metric' });
  });
  it('顺序无关、分隔符宽松', () => {
    expect(parseGenericPartQuery('0402 100nF')).toMatchObject({ footprint: 'C_0402_1005Metric' });
    expect(parseGenericPartQuery('100nF/0402')).toMatchObject({ footprint: 'C_0402_1005Metric' });
  });
  it('具体型号不当成通用件（照常走型号检索）', () => {
    expect(parseGenericPartQuery('CH340C')).toBeNull();
    expect(parseGenericPartQuery('STM32F103C8T6')).toBeNull();
    expect(parseGenericPartQuery('RC0402FR-0710KL')).toBeNull();
  });
  it('无法归类的词 → null，不硬凑', () => {
    expect(parseGenericPartQuery('温湿度传感器')).toBeNull();
    expect(parseGenericPartQuery('')).toBeNull();
  });
});

describe('测试点 / 定位孔的封装（此前落到"默认两脚"）', () => {
  it('TestPoint_Pad_D1.0mm = 单个 φ1.0 圆形焊盘', async () => {
    const { parseKicadFootprintName } = await import('../../src/design-core/geometry/kicad-name-parser');
    const fp = parseKicadFootprintName('TestPoint_Pad_D1.0mm');
    expect(fp).not.toBeNull();
    expect(fp!.pads).toHaveLength(1);
    expect(fp!.pads[0]).toMatchObject({ num: '1', x: 0, y: 0, w: 1, h: 1, round: true });
  });
  it('THT 测试点也是单盘', async () => {
    const { parseKicadFootprintName } = await import('../../src/design-core/geometry/kicad-name-parser');
    const fp = parseKicadFootprintName('TestPoint_THTPad_D1.5mm_Drill0.7mm');
    expect(fp!.pads).toHaveLength(1);
    expect(fp!.pads[0].w).toBe(1.5);
  });
  it('定位孔没有电气焊盘', async () => {
    const { parseKicadFootprintName } = await import('../../src/design-core/geometry/kicad-name-parser');
    const fp = parseKicadFootprintName('MountingHole_3.2mm_M3');
    expect(fp!.pads).toHaveLength(0);
    expect(fp!.bodyW).toBeCloseTo(3.2, 5);
  });
});

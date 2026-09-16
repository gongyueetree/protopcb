/**
 * Phase 14：器件语义唯一实现 —— 四个旧入口都委托 classifyPart，同一颗料在各处得到一致类别
 */
import { describe, it, expect } from 'vitest';
import { classifyPart } from '../../src/design-core/semantics/part';
import { classifyByRefDes } from '../../src/modules/bom/part-class';
import { classFromReference } from '../../src/design-core/part-matching';
import { classifyPassive } from '../../src/design-core/geometry/kicad-passive-defaults';
import { refPrefixFor } from '../../src/design-core/document/services';

describe('证据优先级', () => {
  it('封装比位号更可靠：D1 + LED_0603 → led', () => {
    const s = classifyPart({ reference: 'D1', footprint: 'LED_0603_1608Metric' });
    expect(s.class).toBe('led');
    expect(s.evidence).toBe('footprint');
  });
  it('USB_C_Receptacle 不会因为 "_C_" 被当成电容', () => {
    expect(classifyPart({ reference: 'J1', footprint: 'USB_C_Receptacle_USB2.0_16P' }).class).toBe('connector');
  });
  it('只有位号时按前缀', () => {
    expect(classifyPart({ reference: 'R12' }).class).toBe('resistor');
    expect(classifyPart({ reference: 'FB2' }).class).toBe('ferrite');
    expect(classifyPart({ reference: 'TP3' }).class).toBe('testpoint');
  });
  it('只有抽象类别时兜底，evidence 标为 category', () => {
    const s = classifyPart({ category: 'mcu' });
    expect(s.class).toBe('ic');
    expect(s.evidence).toBe('category');
  });
  it('什么都没有 → unknown / U / 可估价', () => {
    expect(classifyPart({})).toMatchObject({ class: 'unknown', defaultRefPrefix: 'U', priceable: true, evidence: 'none' });
  });
});

describe('派生字段', () => {
  it('无源件给出默认符号', () => {
    expect(classifyPart({ reference: 'C4', value: '100nF' }).defaultSymbol).toBe('Device:C_Small');
    expect(classifyPart({ reference: 'D2', value: 'TVS' }).defaultSymbol).toBe('Device:D_TVS');
  });
  it('结构件与测试点不估价', () => {
    expect(classifyPart({ reference: 'H1' }).priceable).toBe(false);
    expect(classifyPart({ reference: 'TP1' }).priceable).toBe(false);
    expect(classifyPart({ reference: 'U1' }).priceable).toBe(true);
  });
  it('LED 的位号前缀仍是 D（KiCad 习惯）', () => {
    expect(classifyPart({ value: 'LED 绿' }).defaultRefPrefix).toBe('D');
  });
});

describe('四个旧入口互相一致（同一颗料）', () => {
  const cases: [string, string, string][] = [
    ['R7', 'R_0402_1005Metric', '10k'],
    ['C3', 'C_0603_1608Metric', '100nF'],
    ['D5', 'LED_0603_1608Metric', 'green'],
    ['J2', 'PinHeader_1x04_P2.54mm_Vertical', 'CONN'],
    ['Y1', 'Crystal_SMD_3225-4Pin_3.2x2.5mm', '12MHz'],
  ];
  for (const [ref, fp, val] of cases) {
    it(`${ref} ${fp}`, () => {
      // 同样证据 → 同样结论：BOM 入口拿全量证据，选型入口只拿位号，各自与统一分类器对齐
      const bom = classifyByRefDes(ref, fp, val);
      expect(bom).toBe(classifyPart({ reference: ref, footprint: fp, value: val }).class);
      const match = classFromReference(ref);
      expect(match).toBe(classifyPart({ reference: ref }).class);
    });
  }
  it('无源细分与位号前缀也来自同一判定', () => {
    expect(classifyPassive('FB1', '磁珠')).toBe('ferrite');
    expect(refPrefixFor({ category: 'passive', mpn: 'BLM18AG601SN1', description: '铁氧体磁珠' })).toBe('FB');
    expect(refPrefixFor({ category: 'ic', mpn: 'AMS1117-3.3', defaultFootprintName: 'SOT-223' })).toBe('U');
    expect(refPrefixFor({ category: 'connector', mpn: 'USB-C-16P', defaultFootprintName: 'USB_C_Receptacle' })).toBe('J');
  });
});

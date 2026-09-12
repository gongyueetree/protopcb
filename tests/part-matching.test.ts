/**
 * 器件智能匹配：线索提取与候选打分（纯函数，全离线）
 */
import { describe, it, expect } from 'vitest';
import { classFromReference, hintsFromFootprint, hintsFromValue, buildMatchQuery, rankCandidates, type Candidate } from '../src/design-core/part-matching';

describe('位号 → 类别', () => {
  it('常见位号前缀', () => {
    expect(classFromReference('R12')).toBe('resistor');
    expect(classFromReference('C7')).toBe('capacitor');
    expect(classFromReference('D3')).toBe('diode');
    expect(classFromReference('LED1')).toBe('led');      // LED 优先于 L
    expect(classFromReference('L1')).toBe('inductor');
    expect(classFromReference('U6')).toBe('ic');
    expect(classFromReference('J1')).toBe('connector');
    expect(classFromReference('Y1')).toBe('crystal');
    expect(classFromReference('TP1')).toBe('testpoint');
    expect(classFromReference('ZZZ')).toBe('unknown');
  });
});

describe('封装 → 线索', () => {
  it('公制尺寸代号', () => {
    expect(hintsFromFootprint('R_0402_1005Metric').size).toBe('0402');
    expect(hintsFromFootprint('C_0603_1608Metric').size).toBe('0603');
  });
  it('封装族与脚数', () => {
    const a = hintsFromFootprint('SOT-23-5');
    expect(a.family).toBe('SOT-23');
    expect(a.pins).toBe(5);
    const b = hintsFromFootprint('QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm');
    expect(b.family).toBe('QFN');
    expect(b.pins).toBe(32);
    expect(hintsFromFootprint('D_SOD-123').family).toBe('SOD-123');
  });
  it('通孔封装不标 SMD', () => {
    expect(hintsFromFootprint('PinHeader_1x04_P2.54mm_Vertical').smd).toBe(false);
    expect(hintsFromFootprint('R_0402_1005Metric').smd).toBe(true);
  });
});

describe('值/关键词提取', () => {
  it('阻值容值归一化：不同写法同值', () => {
    expect(hintsFromValue('10kΩ').normalized).toBe(hintsFromValue('10K').normalized);
    expect(hintsFromValue('100nF').value).toBe('100n');
    expect(hintsFromValue('1uF').value).toBe('1u');
  });
  it('中文描述抽出英文检索词', () => {
    const v = hintsFromValue('TVS二极管阵列');
    expect(v.keywords).toContain('TVS diode');
    expect(v.keywords).toContain('array');
  });
});

describe('检索计划', () => {
  it('10kΩ + R_0603 → 值/类别/尺寸组合查询', () => {
    const q = buildMatchQuery({ reference: 'R5', mpn: '10kΩ', footprint: 'R_0603_1608Metric' });
    expect(q.partClass).toBe('resistor');
    expect(q.footprint.size).toBe('0603');
    expect(q.queries[0]).toContain('10k');
    expect(q.queries[0]).toContain('resistor');
    expect(q.queries[0]).toContain('0603');
  });
  it('TVS二极管 + SOD-123 → 关键词查询', () => {
    const q = buildMatchQuery({ reference: 'D2', mpn: 'TVS二极管', footprint: 'D_SOD-123' });
    expect(q.partClass).toBe('diode');
    expect(q.queries.join(' ')).toMatch(/TVS/);
    expect(q.queries.join(' ')).toMatch(/SOD-123/);
  });
});

describe('候选打分', () => {
  const q = buildMatchQuery({ reference: 'R5', mpn: '10kΩ', footprint: 'R_0603_1608Metric' });
  const cands: Candidate[] = [
    { mpn: 'RC0603FR-0710KL', description: 'RES 10K OHM 1% 0603', source: 'distributor', vendor: 'Mouser', price: 0.02 },
    { mpn: 'RC0402FR-0710KL', description: 'RES 10K OHM 1% 0402', source: 'distributor', vendor: 'Mouser', price: 0.02 },
    { mpn: 'CC0603KRX7R9BB104', description: 'CAP 100NF 0603', source: 'distributor', vendor: 'Mouser', price: 0.03 },
  ];

  it('同值同封装的电阻排第一', () => {
    const ranked = rankCandidates(q, cands);
    expect(ranked[0].mpn).toBe('RC0603FR-0710KL');
    expect(ranked[0].reasons.join(' ')).toMatch(/0603/);
    expect(ranked[0].reasons.join(' ')).toMatch(/10k/i);
  });

  it('ezPLM 来源优先于分销商（同等匹配度）', () => {
    const ranked = rankCandidates(q, [
      ...cands,
      { mpn: 'EZ-R-10K-0603', description: 'RES 10K 0603 本组织常用', source: 'ezplm' },
    ]);
    expect(ranked[0].source).toBe('ezplm');
    expect(ranked[0].reasons).toContain('来自 ezPLM 器件库');
  });

  it('同 MPN 不同来源只保留高分那条', () => {
    const ranked = rankCandidates(q, [
      { mpn: 'RC0603FR-0710KL', description: 'RES 10K 0603', source: 'distributor', vendor: 'Mouser' },
      { mpn: 'RC0603FR-0710KL', description: 'RES 10K 0603', source: 'ezplm' },
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].source).toBe('ezplm');
  });

  it('类别不符的电容分数低于电阻', () => {
    const ranked = rankCandidates(q, cands);
    const cap = ranked.find((c) => c.mpn.startsWith('CC'))!;
    expect(cap.score).toBeLessThan(ranked[0].score);
  });
});

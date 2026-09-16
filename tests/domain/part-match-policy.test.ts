/**
 * 型号检索门禁：CH340C golden 场景
 * 真实回归：搜 CH340C 时网络结果里混进 Servo PHAT / RFID Reader / Fiber Modem
 */
import { describe, it, expect } from 'vitest';
import { filterAndRank, gradeCandidate, mpnSimilarity, normalizeMpn, mpnCore, looksLikeMpn, type PartLike } from '../../src/design-core/part-match-policy';

/** 报告里给出的真实污染池 */
const POOL: PartLike[] = [
  { mpn: 'CH340C', description: 'USB to serial UART interface IC', category: 'ic', pins: 16 },
  { mpn: 'CH340G', description: 'USB to serial UART interface IC', category: 'ic', pins: 16 },
  { mpn: '24LC00T-I/SN', description: '128 bit EEPROM', category: 'ic', pins: 8 },
  { mpn: 'LSM6DSOPTR', description: '6-axis IMU sensor', category: 'sensor', pins: 14 },
  { mpn: 'ST33K1M5A-SOP', description: 'Secure element', category: 'ic', pins: 8 },
  { mpn: 'Servo PHAT', description: 'Raspberry Pi servo controller pHAT board', category: 'module' },
  { mpn: 'RFID USB-C Reader', description: 'RFID reader with USB-C', category: 'module' },
  { mpn: 'SARA-R5 Update Tool', description: 'Firmware update tool', category: 'module' },
  { mpn: 'Serial Fiber Modem', description: 'RS232 fiber optic modem', category: 'module' },
];

describe('型号规范化与相似度', () => {
  it('大小写/空白/分隔符不敏感', () => {
    expect(normalizeMpn('ch340 c')).toBe(normalizeMpn('CH340C'));
    expect(normalizeMpn('AD9837ACPZ-RL')).toBe('AD9837ACPZRL');
  });
  it('卷带/代理后缀不影响型号主体', () => {
    expect(mpnCore('AD9837ACPZ-RL')).toBe(mpnCore('AD9837ACPZ'));
    expect(mpnCore('MIC5504-3.3YM5-TR')).toBe(mpnCore('MIC5504-3.3YM5'));
  });
  it('同族高、异族低', () => {
    expect(mpnSimilarity('CH340C', 'CH340G')).toBeGreaterThan(0.7);
    expect(mpnSimilarity('CH340C', '24LC00T-I/SN')).toBeLessThan(0.2);
    expect(mpnSimilarity('CH340C', 'Servo PHAT')).toBeLessThan(0.2);
  });
});

describe('CH340C golden（lookup 模式）', () => {
  const r = filterAndRank('CH340C', POOL, 'lookup', { category: 'ic' });

  it('CH340C 精确匹配且排第一', () => {
    expect(r.accepted[0].item.mpn).toBe('CH340C');
    expect(r.accepted[0].grade).toBe('EXACT');
  });

  it('CH340G 最多是同族，不能冒充精确', () => {
    const g = r.accepted.find((x) => x.item.mpn === 'CH340G');
    expect(g).toBeTruthy();
    expect(g!.grade).toBe('FAMILY');
  });

  it('无关器件全部 REJECTED，不进正式结果', () => {
    const accepted = r.accepted.map((x) => x.item.mpn);
    for (const junk of ['24LC00T-I/SN', 'LSM6DSOPTR', 'ST33K1M5A-SOP', 'Servo PHAT', 'RFID USB-C Reader', 'SARA-R5 Update Tool', 'Serial Fiber Modem']) {
      expect(accepted).not.toContain(junk);
      expect(r.rejected.map((x) => x.item.mpn)).toContain(junk);
    }
  });

  it('正式结果只有 2 条（宁可少，不凑数）', () => {
    expect(r.accepted).toHaveLength(2);
    expect(r.nearby).toHaveLength(0);
  });

  it('模块/套件类被明确标注拒绝原因', () => {
    const phat = r.rejected.find((x) => x.item.mpn === 'Servo PHAT')!;
    expect(phat.conflicts.join(' ')).toMatch(/系列不同|不是元件/);
  });
});

describe('负向冲突', () => {
  it('类别不符降级', () => {
    const g = gradeCandidate('CH340C', { mpn: 'CH340X', description: 'x', category: 'passive' }, 'lookup', { category: 'ic' });
    expect(g.grade).toBe('FUZZY');
    expect(g.conflicts.join(' ')).toMatch(/类别不符/);
  });
  it('引脚数差异过大降级', () => {
    const g = gradeCandidate('CH340C', { mpn: 'CH340N', description: 'x', pins: 4 }, 'lookup', { pins: 16 });
    expect(g.conflicts.join(' ')).toMatch(/引脚数差异/);
  });
  it('精确匹配时冲突只作提示，不推翻（同型号不同封装变体）', () => {
    const g = gradeCandidate('CH340C', { mpn: 'CH340C', description: 'x', pins: 4 }, 'lookup', { pins: 16 });
    expect(g.grade).toBe('EXACT');
    expect(g.conflicts.length).toBeGreaterThan(0);
  });
});

describe('模式差异', () => {
  it('substitute 门槛低于 lookup：同族更容易进正式结果', () => {
    const cand: PartLike[] = [{ mpn: 'CH341A', description: 'USB bridge', category: 'ic' }];
    expect(filterAndRank('CH340C', cand, 'lookup').accepted).toHaveLength(0);
    expect(filterAndRank('CH340C', cand, 'substitute').accepted.length + filterAndRank('CH340C', cand, 'substitute').nearby.length).toBeGreaterThan(0);
  });

  it('browse 模式允许关键词相关，但仍拒绝双重冲突项', () => {
    const r = filterAndRank('USB serial', [
      { mpn: 'CH340C', description: 'USB to serial UART', category: 'ic' },
      { mpn: 'XYZ-999', description: 'unrelated widget', category: 'passive', pins: 2 },
    ], 'browse');
    expect(r.accepted.concat(r.nearby).map((x) => x.item.mpn)).toContain('CH340C');
    expect(r.rejected.map((x) => x.item.mpn)).toContain('XYZ-999');
  });
});

describe('查询串判定', () => {
  it('像型号的走 lookup，自然语言走 browse', () => {
    expect(looksLikeMpn('CH340C')).toBe(true);
    expect(looksLikeMpn('STM32F103C8T6')).toBe(true);
    expect(looksLikeMpn('USB 转串口')).toBe(false);
    expect(looksLikeMpn('mcu')).toBe(false);
  });
});

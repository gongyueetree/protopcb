import { describe, it, expect } from 'vitest';
import { AiSchemeSchema, AiSubCircuitSchema, validateAi, assessTrust } from './ai-schema';

describe('LLM 输出必须过 schema（猜测不得变成工程事实）', () => {
  it('合法方案通过', () => {
    const r = validateAi(AiSchemeSchema, {
      summary: '一块 STM32 采集板',
      components: [{ mpn: 'STM32F103C8T6', category: 'mcu', qty: 1 }],
    }, 'AI 方案');
    expect(r.ok).toBe(true);
    expect(r.data!.components[0].mpn).toBe('STM32F103C8T6');
  });

  it('器件数量超上限被整条拒绝', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ mpn: `X${i}`, category: 'ic', qty: 1 }));
    const r = validateAi(AiSchemeSchema, { components: many }, 'AI 方案');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('结构不符合预期');
  });

  it('空器件列表被拒（半个方案比没有方案更危险）', () => {
    expect(validateAi(AiSchemeSchema, { components: [] }, 'AI 方案').ok).toBe(false);
  });

  it('非法类别回落到 ic 而不是污染 store', () => {
    const r = validateAi(AiSchemeSchema, {
      components: [{ mpn: 'X1', category: '魔法器件', qty: 1 }],
    }, 'AI 方案');
    expect(r.ok).toBe(true);
    expect(r.data!.components[0].category).toBe('ic');
  });

  it('异常数量被钳制', () => {
    const r = validateAi(AiSchemeSchema, {
      components: [{ mpn: 'X1', category: 'passive', qty: 99999 }],
    }, 'AI 方案');
    expect(r.ok).toBe(true);
    expect(r.data!.components[0].qty).toBe(1);   // catch 兜底
  });

  it('超长 MPN 被拒', () => {
    const r = validateAi(AiSchemeSchema, {
      components: [{ mpn: 'A'.repeat(200), category: 'ic', qty: 1 }],
    }, 'AI 方案');
    expect(r.ok).toBe(false);
  });

  it('完全不是 JSON 结构时给出可读错误', () => {
    expect(validateAi(AiSchemeSchema, 'not an object', 'AI 方案').ok).toBe(false);
    expect(validateAi(AiSchemeSchema, null, 'AI 方案').error).toContain('AI 方案');
  });

  it('子电路 schema 限制条目数与数量', () => {
    const ok = validateAi(AiSubCircuitSchema, [{ role: '去耦', value: '100nF', qty: 4 }], '子电路');
    expect(ok.ok).toBe(true);
    // 上限放宽到 40：ESP32/FPGA 的典型应用电路本来就有二三十个周边件，
    // 20 会把完全合理的回答整条拒掉（实际踩到过）。
    const many = validateAi(AiSubCircuitSchema, Array.from({ length: 30 }, () => ({ role: 'r', value: 'v' })), '子电路');
    expect(many.ok).toBe(true);
    const bad = validateAi(AiSubCircuitSchema, Array.from({ length: 41 }, () => ({ role: 'r', value: 'v' })), '子电路');
    expect(bad.ok).toBe(false);
  });
});

describe('器件可信等级', () => {
  it('数据库精确命中 → VERIFIED', () => {
    const t = assessTrust('STM32F103C8T6', { mpn: 'STM32F103C8T6', manufacturer: 'ST' });
    expect(t.level).toBe('VERIFIED');
  });

  it('型号格式不同但归一化后一致 → 仍是 VERIFIED', () => {
    expect(assessTrust('stm32f103-c8t6', { mpn: 'STM32F103C8T6' }).level).toBe('VERIFIED');
  });

  it('数据库只有近似型号 → CANDIDATE，不得当作已确认', () => {
    const t = assessTrust('STM32F103C8', { mpn: 'STM32F103CBT6' });
    expect(t.level).toBe('CANDIDATE');
    expect(t.evidence).toContain('STM32F103CBT6');
  });

  it('型号一致但厂商/管脚冲突 → 降级为 CANDIDATE', () => {
    expect(assessTrust('LM358', { mpn: 'LM358', manufacturer: 'TI' }, { manufacturer: 'Onsemi' }).level).toBe('CANDIDATE');
    expect(assessTrust('LM358', { mpn: 'LM358', pins: 8 }, { pins: 14 }).level).toBe('CANDIDATE');
  });

  it('数据库无记录 → PLACEHOLDER 并说明需人工核对', () => {
    const t = assessTrust('MYSTERY-9999');
    expect(t.level).toBe('PLACEHOLDER');
    expect(t.evidence).toContain('datasheet');
  });
});

/**
 * AI 可选字段的契约：missing / undefined / null / 正常值 四种输入都要通过
 * （真实 Gemini 返回过 blocks[0].core = null，导致整条方案被拒）
 */
import { describe, it, expect } from 'vitest';
import { AiSchemeSchema, AiSubCircuitSchema, validateAi } from '../../src/providers/ai-schema';

const base = { mpn: 'STM32F103C8T6', category: 'mcu', qty: 1 };

describe('optional 字段接受 null', () => {
  for (const field of ['manufacturer', 'description', 'footprint', 'reason', 'group'] as const) {
    it(`components[].${field}: 缺失 / null / 正常值都通过`, () => {
      for (const v of [undefined, null, 'x']) {
        const comp = { ...base, ...(v === undefined ? {} : { [field]: v }) };
        const r = validateAi(AiSchemeSchema, { summary: 's', components: [comp] }, 'AI 方案');
        expect(r.ok).toBe(true);
        // null 被规范化成 undefined，下游不必再判 null
        if (v === null) expect((r.data!.components[0] as Record<string, unknown>)[field]).toBeUndefined();
      }
    });
  }

  it('blocks[].core = null 不再让整条方案失败', () => {
    const r = validateAi(AiSchemeSchema, {
      summary: 's', components: [base],
      blocks: [{ id: 'b1', label: '主控', core: null, kind: 'mcu' }],
      blockLinks: [{ from: 'b1', to: 'b2', label: null, kind: 'signal' }],
    }, 'AI 方案');
    expect(r.ok).toBe(true);
    expect(r.data!.blocks![0].core).toBeUndefined();
    expect(r.data!.blockLinks![0].label).toBeUndefined();
  });

  it('summary = null 也可接受', () => {
    expect(validateAi(AiSchemeSchema, { summary: null, components: [base] }, 'AI 方案').ok).toBe(true);
  });

  it('必填字段仍然严格：mpn 为 null 必须拒绝', () => {
    expect(validateAi(AiSchemeSchema, { components: [{ ...base, mpn: null }] }, 'AI 方案').ok).toBe(false);
    expect(validateAi(AiSchemeSchema, { components: [] }, 'AI 方案').ok).toBe(false);
  });

  it('子电路的可选字段同样容忍 null', () => {
    const r = validateAi(AiSubCircuitSchema, [{ role: '去耦', value: '100nF', footprint: null, connectsTo: null }], '子电路');
    expect(r.ok).toBe(true);
  });
});

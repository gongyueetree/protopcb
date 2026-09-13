/**
 * BOM 批量关联：ezPLM → 分销商 → AI 估价的编排逻辑（全离线，依赖注入）
 */
import { describe, it, expect, vi } from 'vitest';
import { autoMatchBom, matchOneLine, classifyMatch, summarizeMatches, type AutoMatchDeps, type BomMatchInput } from '../src/modules/bom/auto-match';
import type { Candidate } from '../src/design-core/part-matching';

const ez = (mpn: string, desc: string, price?: number): Candidate =>
  ({ mpn, description: desc, source: 'ezplm', price, currency: 'CNY' });
const dk = (mpn: string, desc: string, price?: number): Candidate =>
  ({ mpn, description: desc, source: 'distributor', vendor: 'DigiKey', price, currency: 'CNY' });

const line = (reference: string, mpn: string, footprint = '', description = ''): BomMatchInput =>
  ({ reference, mpn, footprint, description, quantity: 1 });

const deps = (over: Partial<AutoMatchDeps> = {}): AutoMatchDeps => ({
  searchEzplm: async () => [],
  searchDistributors: async () => [],
  ...over,
});

describe('匹配等级', () => {
  it('规范化后完全一致 → EXACT（大小写/分隔符不敏感）', () => {
    expect(classifyMatch('AMS1117-3.3', { mpn: 'ams1117 3.3', source: 'ezplm' })).toBe('EXACT');
  });
  it('型号不同 → CANDIDATE，绝不当成同一颗料', () => {
    expect(classifyMatch('STM32F103C8', { mpn: 'STM32F103C8T6', source: 'ezplm' })).toBe('CANDIDATE');
  });
  it('没有候选 → NONE', () => {
    expect(classifyMatch('X', undefined)).toBe('NONE');
  });
});

describe('单行关联的来源顺序', () => {
  it('ezPLM 精确命中后不再查分销商（省配额）', async () => {
    const searchDistributors = vi.fn(async () => [dk('RC0603FR-0710KL', 'RES 10K 0603', 0.02)]);
    const r = await matchOneLine(line('R1', 'RC0603FR-0710KL', 'R_0603_1608Metric'),
      deps({ searchEzplm: async () => [ez('RC0603FR-0710KL', 'RES 10K 0603', 0.03)], searchDistributors }));
    expect(r.level).toBe('EXACT');
    expect(r.best!.source).toBe('ezplm');
    expect(searchDistributors).not.toHaveBeenCalled();
  });

  it('ezPLM 无结果时转分销商', async () => {
    const r = await matchOneLine(line('U1', 'LM2776DBVR', 'SOT-23-6'),
      deps({ searchDistributors: async () => [dk('LM2776DBVR', 'Charge pump SOT-23-6', 1.24)] }));
    expect(r.level).toBe('EXACT');
    expect(r.best!.vendor).toBe('DigiKey');
    expect(r.price).toEqual({ amount: 1.24, currency: 'CNY', kind: 'quote', vendor: 'DigiKey' });
  });

  it('只有值没有型号时按参数匹配 → CANDIDATE，说明里写清依据', async () => {
    const r = await matchOneLine(line('R5', '10kΩ', 'R_0603_1608Metric'),
      deps({ searchDistributors: async () => [dk('RC0603FR-0710KL', 'RES 10K OHM 1% 0603', 0.02)] }));
    expect(r.level).toBe('CANDIDATE');
    expect(r.detail).toMatch(/需人工确认/);
    expect(r.detail).toMatch(/0603|10k/);
  });

  it('全找不到 → NONE，且不编造价格', async () => {
    const r = await matchOneLine(line('U9', 'NOSUCHPART'), deps());
    expect(r.level).toBe('NONE');
    expect(r.best).toBeUndefined();
    expect(r.price).toBeUndefined();
  });
});

describe('AI 估价兜底', () => {
  it('有候选但无报价时才调用估价，且标记为 estimate', async () => {
    const estimatePrice = vi.fn(async () => ({ amount: 0.35, currency: 'CNY', note: '按同类 0603 电阻估算' }));
    const r = await matchOneLine(line('R7', '2k', 'R_0603_1608Metric'),
      deps({ searchDistributors: async () => [dk('RC0603-2K', 'RES 2K 0603')], estimatePrice }));
    expect(estimatePrice).toHaveBeenCalled();
    expect(r.price!.kind).toBe('estimate');
    expect(r.price!.note).toMatch(/估算/);
  });

  it('已有真实报价时不调用估价', async () => {
    const estimatePrice = vi.fn(async () => ({ amount: 9.9, currency: 'CNY' }));
    await matchOneLine(line('U2', 'LM2776DBVR', 'SOT-23-6'),
      deps({ searchDistributors: async () => [dk('LM2776DBVR', 'x', 1.24)], estimatePrice }));
    expect(estimatePrice).not.toHaveBeenCalled();
  });

  it('估价失败不编价格', async () => {
    const r = await matchOneLine(line('R8', '5k1', 'R_0402_1005Metric'),
      deps({ estimatePrice: async () => { throw new Error('offline'); } }));
    expect(r.price).toBeUndefined();
  });
});

describe('批量编排', () => {
  const lines = Array.from({ length: 9 }, (_, i) => line('R' + i, '10k', 'R_0603_1608Metric'));

  it('结果与输入一一对应，进度回调到满', async () => {
    const seen: number[] = [];
    const rs = await autoMatchBom(lines, deps({ searchDistributors: async () => [dk('RC0603FR-0710KL', 'RES 10K 0603', 0.02)] }),
      { concurrency: 3, onProgress: (d, t) => { seen.push(d); expect(t).toBe(9); } });
    expect(rs).toHaveLength(9);
    expect(rs.map((r) => r.reference)).toEqual(lines.map((l) => l.reference));
    expect(Math.max(...seen)).toBe(9);
  });

  it('中断信号生效：不会跑完全部', async () => {
    const signal = { aborted: false };
    const slow = deps({ searchDistributors: async () => { signal.aborted = true; return []; } });
    const rs = await autoMatchBom(lines, slow, { concurrency: 1, signal });
    expect(rs.length).toBeLessThan(lines.length);
  });

  it('单条失败不影响整批', async () => {
    let n = 0;
    const flaky = deps({ searchDistributors: async () => { if (n++ === 0) throw new Error('rate limited'); return [dk('RC0603FR-0710KL', 'RES 10K 0603', 0.02)]; } });
    const rs = await autoMatchBom(lines.slice(0, 3), flaky, { concurrency: 1 });
    expect(rs).toHaveLength(3);
  });
});

describe('汇总', () => {
  it('报价与估价分开累计（不混成一个总价）', () => {
    const s = summarizeMatches([
      { reference: 'R1', inputMpn: 'x', level: 'EXACT', alternatives: [], detail: '', price: { amount: 1, currency: 'CNY', kind: 'quote' } },
      { reference: 'R2', inputMpn: 'y', level: 'CANDIDATE', alternatives: [], detail: '', price: { amount: 2, currency: 'CNY', kind: 'estimate' } },
      { reference: 'R3', inputMpn: 'z', level: 'NONE', alternatives: [], detail: '' },
    ], { R1: 10, R2: 5 });
    expect(s).toMatchObject({ exact: 1, candidate: 1, none: 1, quoted: 1, estimated: 1 });
    expect(s.totalQuoted).toBe(10);
    expect(s.totalEstimated).toBe(10);
  });
});

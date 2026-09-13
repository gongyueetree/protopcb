/**
 * modules/bom/auto-match.ts
 * BOM 批量关联分析。
 *
 * 顺序（与单行「按参数选型」一致，只是批量化）：
 *   1. ezPLM 器件库（自有数据优先）
 *   2. 分销商关键词检索（DigiKey / Mouser…）
 *   3. 都没有 → AI 估价，**明确标注为估算**，不伪装成真实报价
 *
 * 结果分三级，绝不自动写回设计：
 *   EXACT      规范化后型号完全一致 → 可直接用价格
 *   CANDIDATE  按 位号类别 + 封装 + 值 匹配出来的近似料 → 必须人工确认
 *   NONE       找不到
 *
 * 所有外部依赖都通过参数注入，便于离线测试（没有真实 Key 也能验证编排逻辑）。
 */
import { buildMatchQuery, rankCandidates, type Candidate, type ScoredCandidate, type MatchConstraints } from '../../design-core/part-matching';

export type MatchLevel = 'EXACT' | 'CANDIDATE' | 'NONE';

export interface BomMatchInput {
  reference: string;
  mpn: string;
  footprint?: string;
  description?: string;
  quantity: number;
}

export interface PriceInfo {
  amount: number;
  currency: string;
  /** 价格来源：真实报价 / AI 估算 —— 估算绝不能显示成报价 */
  kind: 'quote' | 'estimate';
  vendor?: string;
  note?: string;
}

export interface BomMatchResult {
  reference: string;
  /** 原始 BOM 行的型号（可能只是个值，如 "10k"） */
  inputMpn: string;
  level: MatchLevel;
  best?: ScoredCandidate;
  alternatives: ScoredCandidate[];
  price?: PriceInfo;
  /** 人可读的判定说明 */
  detail: string;
}

export interface AutoMatchDeps {
  /** ezPLM 器件库检索 */
  searchEzplm: (q: string, limit: number) => Promise<Candidate[]>;
  /** 分销商关键词检索（可聚合多家） */
  searchDistributors: (q: string) => Promise<Candidate[]>;
  /** AI 估价（仅在前两步都没有价格时调用） */
  estimatePrice?: (line: BomMatchInput) => Promise<{ amount: number; currency: string; note?: string } | null>;
}

export interface AutoMatchOptions {
  constraints?: MatchConstraints;
  /** 并发上限：太大容易触发上游限流 */
  concurrency?: number;
  onProgress?: (done: number, total: number, last?: BomMatchResult) => void;
  signal?: { aborted: boolean };
}

const normMpn = (v: string) => (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** 判定匹配等级：只有规范化后完全相等才算 EXACT */
export function classifyMatch(inputMpn: string, best?: Candidate): MatchLevel {
  if (!best) return 'NONE';
  const a = normMpn(inputMpn), b = normMpn(best.mpn);
  if (a && b && a === b) return 'EXACT';
  return 'CANDIDATE';
}

/** 从候选里取价格；没有报价则返回 undefined（交给 AI 估价兜底） */
export function priceOf(best?: ScoredCandidate): PriceInfo | undefined {
  if (!best || best.price == null) return undefined;
  return { amount: best.price, currency: best.currency ?? 'CNY', kind: 'quote', vendor: best.vendor };
}

/** 单行关联（导出以便单测） */
export async function matchOneLine(
  line: BomMatchInput,
  deps: AutoMatchDeps,
  opts: AutoMatchOptions = {},
): Promise<BomMatchResult> {
  const query = buildMatchQuery(line);
  const pool: Candidate[] = [];

  // 1) ezPLM：先用原始型号，再用构造出的检索串
  for (const q of [line.mpn, query.queries[0]].filter(Boolean).slice(0, 2)) {
    try {
      const hit = await deps.searchEzplm(q as string, 8);
      pool.push(...hit);
      if (hit.some((h) => normMpn(h.mpn) === normMpn(line.mpn))) break;   // 已精确命中，不必再查
    } catch { /* 单条失败不影响整批 */ }
  }

  // 2) 分销商（ezPLM 没有精确命中时才查，省配额）
  const ezExact = pool.some((c) => normMpn(c.mpn) === normMpn(line.mpn));
  if (!ezExact) {
    for (const q of [line.mpn, query.queries[0]].filter(Boolean).slice(0, 2)) {
      try {
        const hit = await deps.searchDistributors(q as string);
        pool.push(...hit);
        if (hit.length) break;
      } catch { /* 忽略单家失败 */ }
    }
  }

  const ranked = rankCandidates(query, pool, opts.constraints);
  const best = ranked[0];
  const level = classifyMatch(line.mpn, best);
  let price = priceOf(best);

  // 3) 都没有价格 → AI 估价（明确标注）
  if (!price && deps.estimatePrice) {
    try {
      const est = await deps.estimatePrice(line);
      if (est) price = { amount: est.amount, currency: est.currency, kind: 'estimate', note: est.note };
    } catch { /* 估价失败就没有价格，不编 */ }
  }

  const detail = level === 'EXACT'
    ? `型号精确匹配${best.source === 'ezplm' ? '（ezPLM 器件库）' : `（${best.vendor ?? '分销商'}）`}`
    : level === 'CANDIDATE'
      ? `按 ${[query.value.value && `值 ${query.value.value}`, query.footprint.size, query.footprint.family].filter(Boolean).join(' / ') || '关键词'} 匹配到近似料，需人工确认`
      : 'ezPLM 与分销商均未查到';

  return { reference: line.reference, inputMpn: line.mpn, level, best, alternatives: ranked.slice(1, 6), price, detail };
}

/**
 * 批量关联。并发受限、可中断、逐条回调进度。
 * 结果顺序与输入一致，便于直接对齐 BOM 行。
 */
export async function autoMatchBom(
  lines: BomMatchInput[],
  deps: AutoMatchDeps,
  opts: AutoMatchOptions = {},
): Promise<BomMatchResult[]> {
  const concurrency = Math.max(1, Math.min(6, opts.concurrency ?? 3));
  const results: BomMatchResult[] = new Array(lines.length);
  let next = 0, done = 0;

  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (i >= lines.length) return;
      results[i] = await matchOneLine(lines[i], deps, opts);
      done++;
      opts.onProgress?.(done, lines.length, results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, lines.length) }, worker));
  return results.filter(Boolean);
}

/** 汇总：各等级条数与可计算的总价（估算单独计） */
export function summarizeMatches(rs: BomMatchResult[], quantities: Record<string, number> = {}) {
  let exact = 0, candidate = 0, none = 0, quoted = 0, estimated = 0;
  let totalQuoted = 0, totalEstimated = 0;
  for (const r of rs) {
    if (r.level === 'EXACT') exact++; else if (r.level === 'CANDIDATE') candidate++; else none++;
    const qty = quantities[r.reference] ?? 1;
    if (r.price?.kind === 'quote') { quoted++; totalQuoted += r.price.amount * qty; }
    if (r.price?.kind === 'estimate') { estimated++; totalEstimated += r.price.amount * qty; }
  }
  return { exact, candidate, none, quoted, estimated, totalQuoted, totalEstimated };
}

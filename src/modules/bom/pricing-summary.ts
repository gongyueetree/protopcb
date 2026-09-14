/**
 * modules/bom/pricing-summary.ts
 * BOM 报价覆盖度汇总。
 *
 * 修复的问题：此前底部直接显示一个"BOM 总价"，而它是把
 * 已报价、AI 估价、以及**根本没有价格的行按 0 计入**后加出来的 ——
 * 12 行里只有 8 行有价，显示出来的总价依然像是完整的采购成本，会误导决策。
 *
 * 规则：只有"全部行都有价格且币种唯一"才允许出现"总价"字样；
 * 否则只报覆盖度与分项小计，估价与报价分开列。
 */
import type { Money } from '../../design-core/money';
import { sumByCurrency } from '../../design-core/money';

export interface BomPriceRow {
  /** 单价；没有价格就是 undefined，绝不用 0 代替 */
  price?: Money;
  /** 该价格是真实报价还是估算 */
  kind?: 'quote' | 'estimate';
  quantity: number;
}

export interface BomPricingSummary {
  totalLines: number;
  quotedLines: number;
  estimatedLines: number;
  unknownLines: number;
  /** 按币种分组的小计（extended = 单价 × 数量） */
  quotedByCurrency: Record<string, number>;
  estimatedByCurrency: Record<string, number>;
  /** 全部行都有价格 */
  complete: boolean;
  /** 币种唯一（含 0 或 1 种） */
  singleCurrency: boolean;
  /** 只有 complete && singleCurrency 才允许展示"总价" */
  canShowTotal: boolean;
  currency?: string;
  total?: number;
}

export function summarizeBomPricing(rows: BomPriceRow[]): BomPricingSummary {
  const quoted: Money[] = [], estimated: Money[] = [];
  let unknownLines = 0;
  for (const r of rows) {
    if (!r.price || !Number.isFinite(r.price.amount)) { unknownLines++; continue; }
    const ext: Money = { amount: r.price.amount * (r.quantity || 1), currency: r.price.currency };
    if (r.kind === 'estimate') estimated.push(ext); else quoted.push(ext);
  }
  const quotedByCurrency = sumByCurrency(quoted);
  const estimatedByCurrency = sumByCurrency(estimated);
  const currencies = new Set([...Object.keys(quotedByCurrency), ...Object.keys(estimatedByCurrency)]);
  const complete = unknownLines === 0 && rows.length > 0;
  const singleCurrency = currencies.size <= 1 && !currencies.has('UNKNOWN');
  const canShowTotal = complete && singleCurrency;
  const currency = [...currencies][0];
  return {
    totalLines: rows.length,
    quotedLines: quoted.length,
    estimatedLines: estimated.length,
    unknownLines,
    quotedByCurrency, estimatedByCurrency,
    complete, singleCurrency, canShowTotal,
    currency: canShowTotal ? currency : undefined,
    total: canShowTotal ? (quotedByCurrency[currency] ?? 0) + (estimatedByCurrency[currency] ?? 0) : undefined,
  };
}

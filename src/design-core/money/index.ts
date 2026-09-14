/**
 * design-core/money/index.ts
 * 金额格式化的**唯一**入口。
 *
 * 修复的问题：旧的 fmtMoney(amount) 按界面语言选符号 —— 中文显示 ¥、英文显示 $，
 * 但数值一分没变。一条 CNY 12.50 的报价切到英文就成了 "$12.50"，
 * 这不是本地化，是**把人民币标成了美元**，会直接误导采购。
 *
 * 规则：
 *   locale 只影响数字格式（千分位、小数点），绝不改变币种；
 *   没有币种信息就如实说"币种未知"，不猜；
 *   本模块不做任何汇率换算 —— 要做必须带 rate/timestamp/source，另行设计。
 */

export interface Money {
  amount: number;
  /** ISO 4217，如 CNY / USD；缺失表示上游没给 */
  currency?: string;
}

const SYMBOL: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£', HKD: 'HK$', TWD: 'NT$' };

/** 数字部分：按 locale 决定分组与小数位，与币种无关 */
function formatNumber(amount: number, locale: string, digits = 2): string {
  const d = Math.abs(amount) > 0 && Math.abs(amount) < 0.1 ? Math.max(digits, 4) : digits;
  try {
    return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
      minimumFractionDigits: d, maximumFractionDigits: d,
    }).format(amount);
  } catch {
    return amount.toFixed(d);
  }
}

/**
 * 格式化金额。
 * @param locale 'zh' | 'en' —— 只影响数字写法
 *
 * CNY 在英文下写作 `CN¥`：`¥` 在英文语境里会被读成日元，必须带国别前缀区分。
 */
export function formatMoney(money: Money | undefined | null, locale: 'zh' | 'en' = 'zh'): string {
  if (!money || typeof money.amount !== 'number' || !Number.isFinite(money.amount)) return '—';
  const num = formatNumber(money.amount, locale);
  const cur = (money.currency ?? '').toUpperCase();
  if (!cur) return locale === 'en' ? `${num} · currency unknown` : `${num} · 币种未知`;
  const sym = SYMBOL[cur];
  if (!sym) return `${cur} ${num}`;                       // 无符号的币种直接写代码
  if (locale === 'en' && (cur === 'CNY' || cur === 'JPY')) return `${cur === 'CNY' ? 'CN¥' : 'JP¥'}${num}`;
  return `${sym}${num}`;
}

/** 同币种求和；币种不一致返回 null（调用方必须分币种展示，不许硬加） */
export function sumMoney(items: (Money | undefined)[]): Money | null {
  const valid = items.filter((m): m is Money => !!m && Number.isFinite(m.amount));
  if (!valid.length) return null;
  const currencies = new Set(valid.map((m) => (m.currency ?? '').toUpperCase()));
  if (currencies.size > 1) return null;
  return { amount: valid.reduce((a, m) => a + m.amount, 0), currency: valid[0].currency };
}

/** 按币种分组求和，用于混币种 BOM */
export function sumByCurrency(items: (Money | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of items) {
    if (!m || !Number.isFinite(m.amount)) continue;
    const cur = (m.currency ?? 'UNKNOWN').toUpperCase();
    out[cur] = (out[cur] ?? 0) + m.amount;
  }
  return out;
}

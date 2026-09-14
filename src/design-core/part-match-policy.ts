/**
 * design-core/part-match-policy.ts
 * 型号检索的**统一门禁**。
 *
 * 修复的问题：搜 `CH340C`，网络结果里混进 Servo PHAT、RFID USB-C Reader、
 * SARA-R5 Update Tool、Serial Fiber Modem —— 上游按全文相关度返回，我们直接
 * 把顺序当成候选展示了。用户看到的"搜索结果"里有一半是完全不相干的东西。
 *
 * 三种模式，对应三种意图：
 *   lookup      用户在找**这一颗**料（CH340C）。只有精确/同族可进正式结果。
 *   substitute  用户在找替代料。同族与参数相近可进，但必须标注为候选。
 *   browse      用户在按类别/关键词浏览。门槛最低，但仍拒绝明显冲突项。
 *
 * 分级：EXACT > FAMILY > FUZZY > REJECTED。
 * REJECTED 永远不进正式结果 —— 宁可显示"没有合格候选"，也不为了凑数展示垃圾。
 */

export type MatchMode = 'lookup' | 'substitute' | 'browse';
export type MatchGrade = 'EXACT' | 'FAMILY' | 'FUZZY' | 'REJECTED';

export interface PartLike {
  mpn: string;
  manufacturer?: string;
  description?: string;
  category?: string;
  footprint?: string;
  pins?: number;
}

export interface GradeResult {
  grade: MatchGrade;
  score: number;
  /** 判定理由，直接展示给用户 */
  reasons: string[];
  /** 命中的负向冲突（导致降级或拒绝） */
  conflicts: string[];
}

/** 型号规范化：大写、去空白、把各种分隔符统一成 '-' 后再去掉 */
export function normalizeMpn(v: string): string {
  return (v ?? '').toUpperCase().replace(/[\s_/]+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-/g, '');
}

/** 去掉常见的包装/批次后缀，得到可比较的"型号主体" */
export function mpnCore(v: string): string {
  let s = normalizeMpn(v);
  // -RL / -TR / -T / -R7 / -ND 等卷带、代理商后缀不影响器件本体
  s = s.replace(/(RL7|RL|TR13|TR7|TR|REEL|CT|ND)$/,'');
  return s;
}

/**
 * 两个型号的族相似度 0~1。
 * 以**公共前缀长度**为主：硬件型号的区分度集中在前缀
 * （CH340C 与 CH340G 同族；CH340C 与 24LC00 毫无关系）。
 */
export function mpnSimilarity(a: string, b: string): number {
  const x = mpnCore(a), y = mpnCore(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  const longer = Math.max(x.length, y.length);
  // 前缀至少要覆盖较长串的一半，才谈得上同族
  return i / longer;
}

/** 型号里的字母前缀（CH340C → CH），用于快速排除完全不同的系列 */
function alphaPrefix(v: string): string {
  return (mpnCore(v).match(/^[A-Z]+/) ?? [''])[0];
}

const CAT_ALIAS: Record<string, string> = {
  mcu: 'ic', ic: 'ic', power: 'ic', rf: 'ic', sensor: 'ic',
  passive: 'passive', connector: 'connector', electromech: 'connector', module: 'module',
};
const catOf = (v?: string) => CAT_ALIAS[(v ?? '').toLowerCase()] ?? (v ?? '').toLowerCase();

/** 明显是"套件/模块/工具"而不是元件的关键词 —— lookup 模式下直接拒绝 */
const NON_PART = /\b(PHAT|HAT|SHIELD|KIT|BOARD|MODULE|READER|MODEM|GATEWAY|DEVKIT|EVAL|TOOL|CABLE|ADAPTER|ENCLOSURE|ANTENNA|BREAKOUT)\b/;

export interface GradeOptions {
  /** 期望类别（来自位号或用户筛选） */
  category?: string;
  /** 期望引脚数 */
  pins?: number;
  /** 期望封装名 */
  footprint?: string;
}

/**
 * 给单个候选评级。
 * @param queryMpn 用户输入的型号（lookup 模式下这是硬约束）
 */
export function gradeCandidate(
  queryMpn: string, cand: PartLike, mode: MatchMode, opts: GradeOptions = {},
): GradeResult {
  const reasons: string[] = [];
  const conflicts: string[] = [];
  const sim = mpnSimilarity(queryMpn, cand.mpn);
  const qPrefix = alphaPrefix(queryMpn), cPrefix = alphaPrefix(cand.mpn);
  const hay = `${cand.mpn} ${cand.description ?? ''}`.toUpperCase();

  // ── 负向冲突 ──
  if (opts.category && cand.category && catOf(opts.category) !== catOf(cand.category)) {
    conflicts.push(`类别不符（期望 ${opts.category}，候选 ${cand.category}）`);
  }
  if (opts.pins && cand.pins && Math.abs(opts.pins - cand.pins) / Math.max(opts.pins, cand.pins) > 0.5) {
    conflicts.push(`引脚数差异过大（${opts.pins} vs ${cand.pins}）`);
  }
  if (opts.footprint && cand.footprint) {
    const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!norm(cand.footprint).includes(norm(opts.footprint).slice(0, 6)) && !norm(opts.footprint).includes(norm(cand.footprint).slice(0, 6))) {
      conflicts.push('封装明显不同');
    }
  }

  // ── 精确 ──
  if (sim === 1) {
    reasons.push('型号精确匹配');
    // 精确匹配时冲突只作提示，不推翻（同一型号不同封装变体仍是同一颗料）
    return { grade: 'EXACT', score: 1000, reasons, conflicts };
  }

  // lookup 模式：字母前缀不同 = 不同系列，直接拒绝
  if (mode === 'lookup' && qPrefix && cPrefix && qPrefix !== cPrefix) {
    return { grade: 'REJECTED', score: 0, reasons, conflicts: [...conflicts, `系列不同（${qPrefix} vs ${cPrefix}）`] };
  }
  // lookup 模式：模块/套件/工具类不是元件
  if (mode === 'lookup' && NON_PART.test(hay)) {
    return { grade: 'REJECTED', score: 0, reasons, conflicts: [...conflicts, '不是元件（模块/套件/工具类）'] };
  }

  // ── 同族 ──
  const familyThreshold = mode === 'lookup' ? 0.7 : mode === 'substitute' ? 0.55 : 0.4;
  if (sim >= familyThreshold) {
    reasons.push(`同族型号（相似度 ${(sim * 100).toFixed(0)}%）`);
    if (conflicts.length) {
      // 同族但参数冲突：降到 FUZZY，只能进"相近候选"
      return { grade: 'FUZZY', score: 300 + sim * 100, reasons, conflicts };
    }
    return { grade: 'FAMILY', score: 600 + sim * 200, reasons, conflicts };
  }

  // ── 模糊 / 拒绝 ──
  if (mode === 'lookup') {
    return { grade: 'REJECTED', score: 0, reasons, conflicts: [...conflicts, `型号相似度过低（${(sim * 100).toFixed(0)}%）`] };
  }
  if (conflicts.length >= 2) {
    return { grade: 'REJECTED', score: 0, reasons, conflicts };
  }
  const kwHit = queryMpn.split(/\s+/).filter((t) => t.length >= 3).some((t) => hay.includes(t.toUpperCase()));
  if (!kwHit && sim < 0.2) {
    return { grade: 'REJECTED', score: 0, reasons, conflicts: [...conflicts, '与查询无关'] };
  }
  return { grade: 'FUZZY', score: 100 + sim * 100, reasons: [...reasons, '关键词相关'], conflicts };
}

export interface GradedCandidate<T extends PartLike = PartLike> {
  item: T;
  grade: MatchGrade;
  score: number;
  reasons: string[];
  conflicts: string[];
}

export interface FilteredResults<T extends PartLike = PartLike> {
  /** 正式结果：EXACT / FAMILY */
  accepted: GradedCandidate<T>[];
  /** 相近候选：FUZZY —— UI 必须单独分区展示，不能混进正式结果 */
  nearby: GradedCandidate<T>[];
  /** 被拒绝的（仅用于诊断/日志） */
  rejected: GradedCandidate<T>[];
}

/**
 * 门禁 + 排序。
 * 正式结果按 EXACT → FAMILY → 分数排序；FUZZY 单独一组。
 */
export function filterAndRank<T extends PartLike>(
  queryMpn: string, candidates: T[], mode: MatchMode, opts: GradeOptions = {},
): FilteredResults<T> {
  const graded: GradedCandidate<T>[] = candidates.map((item) => {
    const g = gradeCandidate(queryMpn, item, mode, opts);
    return { item, ...g };
  });
  const byScore = (a: GradedCandidate<T>, b: GradedCandidate<T>) => b.score - a.score;
  return {
    accepted: graded.filter((g) => g.grade === 'EXACT' || g.grade === 'FAMILY').sort(byScore),
    nearby: graded.filter((g) => g.grade === 'FUZZY').sort(byScore),
    rejected: graded.filter((g) => g.grade === 'REJECTED'),
  };
}

/** 查询串是否像一个具体型号（决定用 lookup 还是 browse） */
export function looksLikeMpn(q: string): boolean {
  const s = (q ?? '').trim();
  if (s.length < 4 || /\s/.test(s)) return false;
  // 至少含数字，且字母数字混排（CH340C、STM32F103C8T6、AD9837ACPZ-RL）
  return /\d/.test(s) && /[A-Za-z]/.test(s);
}

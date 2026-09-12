/**
 * design-core/part-matching.ts
 * 器件智能匹配 —— 为"型号不完整"的 BOM 行（10kΩ、TVS二极管、100nF…）构造检索线索并给候选打分。
 *
 * 三条线索全部来自 BOM 行本身，不靠 LLM 猜：
 *   1. 位号前缀  → 器件类别（R=电阻、C=电容、U=IC、Y=晶振…）
 *   2. 封装名     → 封装族 + 尺寸代号（R_0402_1005Metric → 0402；SOT-23-5 → SOT-23 5脚）
 *   3. 型号/描述  → 值（10k / 100nF / 3.3V）与关键词（TVS、LDO、MOSFET…）
 *
 * 打分只用可核对的匹配事实（类别一致、封装一致、值一致…），
 * 候选**永远需要用户确认**才会写回设计 —— 不自动替换（沿用 AI trust 的同一条原则）。
 */

export type PartClass = 'resistor' | 'capacitor' | 'inductor' | 'diode' | 'led' | 'transistor'
  | 'ic' | 'connector' | 'crystal' | 'switch' | 'fuse' | 'testpoint' | 'mounting' | 'unknown';

const REF_CLASS: [RegExp, PartClass][] = [
  [/^R[0-9]/i, 'resistor'], [/^RN[0-9]/i, 'resistor'],
  [/^C[0-9]/i, 'capacitor'], [/^L[0-9]/i, 'inductor'], [/^FB[0-9]/i, 'inductor'],
  [/^(D|ZD)[0-9]/i, 'diode'], [/^(LED|DS)[0-9]/i, 'led'],
  [/^(Q|T)[0-9]/i, 'transistor'],
  [/^(U|IC)[0-9]/i, 'ic'],
  [/^(J|P|CN|CON)[0-9]/i, 'connector'],
  [/^(Y|X|XTAL)[0-9]/i, 'crystal'],
  [/^(SW|S|K)[0-9]/i, 'switch'],
  [/^(F|FU)[0-9]/i, 'fuse'],
  [/^TP[0-9]/i, 'testpoint'],
  [/^(H|MH|MK)[0-9]/i, 'mounting'],
];

export const CLASS_LABEL: Record<PartClass, string> = {
  resistor: '电阻', capacitor: '电容', inductor: '电感/磁珠', diode: '二极管', led: 'LED',
  transistor: '晶体管', ic: '集成电路', connector: '连接器', crystal: '晶振/谐振器',
  switch: '开关/按键', fuse: '保险丝', testpoint: '测试点', mounting: '安装件', unknown: '未分类',
};

/** 位号 → 器件类别（LED 优先于 L，判定顺序已处理） */
export function classFromReference(reference: string): PartClass {
  const ref = String(reference ?? '').trim().toUpperCase();
  if (/^LED[0-9]/.test(ref)) return 'led';
  for (const [re, cls] of REF_CLASS) if (re.test(ref)) return cls;
  return 'unknown';
}

export interface FootprintHints {
  /** 公制/英制尺寸代号，如 0402 / 0603 */
  size?: string;
  /** 封装族，如 SOT-23 / SOIC / QFN / SOD-123 / LQFP */
  family?: string;
  /** 引脚数（封装名里能读到时） */
  pins?: number;
  /** 是否贴片（无通孔标记时按贴片处理） */
  smd: boolean;
}

/** 从 KiCad 风格封装名提取检索线索 */
export function hintsFromFootprint(footprint: string): FootprintHints {
  const fp = String(footprint ?? '');
  const N = fp.toUpperCase();
  const out: FootprintHints = { smd: !/(THT|_THT|PinHeader|DIP-|TO-220|TO-92|RADIAL|AXIAL)/i.test(fp) };

  // 注意：\b 在 R_0402_1005 这种下划线分隔的名字里不成立（_ 也是单词字符），故用数字边界
  const size = N.match(/(?<![0-9])(0201|0402|0603|0805|1206|1210|1812|2010|2512)(?![0-9])/);
  if (size) out.size = size[1];

  const fam = N.match(/(?<![A-Z0-9])(SOT-?\d{2,3}|SOD-?\d{2,3}|SSOP|TSSOP|MSOP|SOIC|SOP|QFN|DFN|LQFP|TQFP|QFP|BGA|WLCSP|TO-?\d{2,3}|D2PAK|DPAK|SMA|SMB|SMC|DIP)(?![A-Z0-9])/);
  if (fam) out.family = fam[1].replace(/^(SOT|SOD|TO)(\d)/, '$1-$2');

  // SOT-23-5 / QFN-32 / LQFP-48 结尾的脚数
  const pins = N.match(/(?:SOT-?\d{2,3}|SOD-?\d{2,3}|SOIC|SOP|SSOP|TSSOP|MSOP|QFN|DFN|LQFP|TQFP|QFP|BGA|DIP)-(\d{1,3})/);
  if (pins) out.pins = parseInt(pins[1], 10);
  return out;
}

export interface ValueHints {
  /** 归一化的元件值，如 10k / 100n / 4u7 */
  value?: string;
  /** 归一化后的数值 + 单位（用于同值不同写法的比较） */
  normalized?: string;
  /** 检索关键词（英文优先，便于分销商接口） */
  keywords: string[];
}

const ZH_KEYWORDS: [RegExp, string][] = [
  [/TVS|瞬态/i, 'TVS diode'], [/肖特基/, 'Schottky diode'], [/稳压二极管|齐纳/, 'Zener diode'],
  [/二极管/, 'diode'], [/三极管/, 'transistor'], [/场效应|MOS/i, 'MOSFET'],
  [/晶振|谐振/, 'crystal'], [/电感/, 'inductor'], [/磁珠/, 'ferrite bead'],
  [/排针|排母/, 'pin header'], [/按键|轻触/, 'tactile switch'], [/保险丝/, 'fuse'],
  [/稳压器|LDO/i, 'LDO regulator'], [/运放|运算放大/, 'operational amplifier'],
  [/阵列/, 'array'], [/贴片/, 'SMD'],
];

/**
 * 从型号/描述提取值与关键词。
 * 值的归一化把 10kΩ / 10K / 10 kohm 统一成 10k，100nF / 0.1uF 统一成 100n，
 * 这样"同一个值的不同写法"能互相匹配。
 */
export function hintsFromValue(mpnOrValue: string, description = ''): ValueHints {
  const raw = `${mpnOrValue ?? ''} ${description ?? ''}`.trim();
  const out: ValueHints = { keywords: [] };

  // 阻值/容值/感值：数字 + 可选小数 + 单位前缀 + 可选单位
  const m = raw.match(/(\d+(?:\.\d+)?)\s*([pnuµmkKMG])?\s*(ohm|Ω|R|F|H)?\b/i);
  if (m && (m[2] || m[3])) {
    const numPart = m[1];
    const prefix = (m[2] ?? '').replace('µ', 'u');
    const unit = (m[3] ?? '').toUpperCase().replace('OHM', 'R').replace('Ω', 'R');
    out.value = `${numPart}${prefix}`;
    out.normalized = `${parseFloat(numPart)}${prefix.toLowerCase()}${unit === 'R' ? 'ohm' : unit.toLowerCase()}`;
  }
  // R/C 常见的 4k7、1R5 写法
  const rc = raw.match(/\b(\d+)([RKMpnu])(\d+)\b/i);
  if (rc && !out.value) {
    out.value = `${rc[1]}.${rc[3]}${rc[2].toLowerCase()}`;
    out.normalized = `${parseFloat(`${rc[1]}.${rc[3]}`)}${rc[2].toLowerCase()}`;
  }

  for (const [re, kw] of ZH_KEYWORDS) if (re.test(raw)) out.keywords.push(kw);
  // 英文里本来就有的型号词根（>=3 字母的连续串）
  for (const w of raw.match(/[A-Za-z]{3,}/g) ?? []) {
    const lw = w.toLowerCase();
    if (!['the', 'and', 'for', 'with', 'smd', 'metric'].includes(lw) && !out.keywords.includes(w)) out.keywords.push(w);
  }
  out.keywords = [...new Set(out.keywords)].slice(0, 6);
  return out;
}

export interface MatchQuery {
  reference: string;
  partClass: PartClass;
  footprint: FootprintHints;
  value: ValueHints;
  /** 送给检索接口的查询串（按优先级排列，逐条尝试） */
  queries: string[];
}

/** 由一条 BOM 行构造检索计划 */
export function buildMatchQuery(line: { reference: string; mpn: string; footprint?: string; description?: string }): MatchQuery {
  const partClass = classFromReference(line.reference);
  const fp = hintsFromFootprint(line.footprint ?? '');
  const val = hintsFromValue(line.mpn ?? '', line.description ?? '');

  const classTerm: Partial<Record<PartClass, string>> = {
    resistor: 'resistor', capacitor: 'capacitor', inductor: 'inductor', diode: 'diode',
    led: 'LED', transistor: 'transistor', crystal: 'crystal', connector: 'connector',
    switch: 'switch', fuse: 'fuse', ic: '',
  };
  const parts = [val.value, classTerm[partClass], fp.size, fp.family && fp.pins ? `${fp.family}-${fp.pins}` : fp.family]
    .filter(Boolean) as string[];

  const queries: string[] = [];
  if (parts.length) queries.push(parts.join(' '));                       // 最具体
  if (val.value && fp.size) queries.push(`${val.value} ${fp.size}`);      // 值 + 尺寸
  if (val.keywords.length) queries.push([...val.keywords.slice(0, 3), fp.family].filter(Boolean).join(' '));
  if (line.mpn) queries.push(line.mpn);                                   // 原始串兜底
  return { reference: line.reference, partClass, footprint: fp, value: val, queries: [...new Set(queries)].filter(Boolean) };
}

export interface Candidate {
  mpn: string;
  manufacturer?: string;
  description?: string;
  footprint?: string;
  category?: string;
  source: 'ezplm' | 'distributor';
  vendor?: string;
  price?: number;
  currency?: string;
  stock?: number;
  url?: string;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  /** 命中的匹配理由（展示给用户，便于判断该不该采用） */
  reasons: string[];
}

/**
 * 候选打分：只加可核对的匹配事实。
 * ezPLM 来源加权（自有库优先于分销商，与 Reference Design 的来源分层一致）。
 */
export function scoreCandidate(q: MatchQuery, c: Candidate): ScoredCandidate {
  let score = 0;
  const reasons: string[] = [];
  const hay = `${c.mpn} ${c.description ?? ''} ${c.footprint ?? ''} ${c.category ?? ''}`.toUpperCase();

  if (c.source === 'ezplm') { score += 300; reasons.push('来自 ezPLM 器件库'); }

  if (q.value.value) {
    const v = q.value.value.toUpperCase();
    if (hay.includes(v)) { score += 200; reasons.push(`值匹配 ${q.value.value}`); }
  }
  if (q.footprint.size && hay.includes(q.footprint.size)) { score += 160; reasons.push(`封装尺寸 ${q.footprint.size}`); }
  if (q.footprint.family && hay.includes(q.footprint.family.toUpperCase())) { score += 120; reasons.push(`封装族 ${q.footprint.family}`); }
  if (q.footprint.pins && new RegExp(`-${q.footprint.pins}\\b`).test(hay)) { score += 60; reasons.push(`${q.footprint.pins} 脚`); }

  const clsTerms: Partial<Record<PartClass, RegExp>> = {
    resistor: /RESISTOR|电阻/, capacitor: /CAPACITOR|电容|MLCC/, inductor: /INDUCTOR|电感|BEAD|磁珠/,
    diode: /DIODE|二极管|TVS|SCHOTTKY|ZENER/, led: /LED/, transistor: /TRANSISTOR|MOSFET|三极管/,
    crystal: /CRYSTAL|OSCILLATOR|晶振/, connector: /CONNECTOR|HEADER|连接器|排针/,
    switch: /SWITCH|按键|开关/, fuse: /FUSE|保险/,
  };
  const ct = clsTerms[q.partClass];
  if (ct && ct.test(hay)) { score += 100; reasons.push(`类别匹配 ${CLASS_LABEL[q.partClass]}`); }

  for (const kw of q.value.keywords) if (hay.includes(kw.toUpperCase())) score += 25;
  if (c.price != null) { score += 30; reasons.push('有报价'); }
  if (c.stock != null && c.stock > 0) score += 20;

  return { ...c, score, reasons };
}

/** 排序 + 去重（同一 MPN 保留分数最高的来源） */
export function rankCandidates(q: MatchQuery, list: Candidate[]): ScoredCandidate[] {
  const best = new Map<string, ScoredCandidate>();
  for (const c of list) {
    if (!c.mpn) continue;
    const scored = scoreCandidate(q, c);
    const key = c.mpn.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const prev = best.get(key);
    if (!prev || scored.score > prev.score) best.set(key, scored);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

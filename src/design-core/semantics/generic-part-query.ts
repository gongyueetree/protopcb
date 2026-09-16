/**
 * design-core/semantics/generic-part-query.ts
 * 通用无源件查询的识别：「Cap」「电容」「100nF」「10k 0402」「22uH 0805」这类。
 *
 * 问题背景：这些查询在 ezPLM / 分销商里都搜不到——它们不是型号，是**值**。
 * 之前结果是"找到 0 个"，用户还得自己去 KiCad 封装库页手动拼。
 * 现在识别出来直接给一个通用件（KiCad 官方符号 + 公制封装），
 * 并如实标注：它是通用值器件，不是经过库验证的具体型号。
 */
import { classifyPart, type PassiveKind } from './part';
import { kicadPassiveDefaults } from '../geometry/kicad-passive-defaults';

export interface GenericPartQuery {
  kind: PassiveKind;
  /** 规范化后的值，如 100nF / 10kΩ / 22µH；没给值时为 undefined */
  value?: string;
  /** 尺寸代号，如 0402；没给时用该类默认 */
  size?: string;
  /** KiCad 官方符号 */
  symbol: string;
  /** KiCad 官方封装 */
  footprint: string;
  /** 展示名：值 + 封装 */
  label: string;
}

/** 类别关键词 → 位号前缀（喂给统一分类器） */
const KIND_WORDS: [RegExp, string][] = [
  [/^(c|cap|caps|capacitor|电容|мlcc|mlcc)$/i, 'C1'],
  [/^(r|res|resistor|电阻)$/i, 'R1'],
  [/^(l|ind|inductor|电感)$/i, 'L1'],
  [/^(fb|ferrite|磁珠)$/i, 'FB1'],
  [/^(d|diode|二极管)$/i, 'D1'],
  [/^(led|发光二极管)$/i, 'LED1'],
  [/^(y|xtal|crystal|晶振)$/i, 'Y1'],
];

const SIZE_RE = /(?<![0-9])(0201|0402|0603|0805|1206|1210|1812|2010|2512)(?![0-9])/;
/** 电容/电感/电阻的值写法 */
const VALUE_RE = /^\d+(?:\.\d+)?\s*(pF|nF|uF|µF|μF|F|nH|uH|µH|μH|mH|H|[kKmM]?(?:Ω|R|ohm)?)$/i;

const normValue = (v: string) => v.replace(/\s+/g, '').replace(/μ|µ/g, 'u')
  .replace(/ohm/i, 'Ω').replace(/^(\d+(?:\.\d+)?)([kKmM])$/, '$1$2Ω');

/**
 * 解析查询串。识别不出通用件时返回 null（照常走型号检索，不硬凑）。
 */
export function parseGenericPartQuery(query: string): GenericPartQuery | null {
  const q = (query ?? '').trim();
  if (!q) return null;
  const tokens = q.split(/[\s,，/]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 3) return null;

  let size: string | undefined;
  let value: string | undefined;
  let refHint: string | undefined;

  for (const tk of tokens) {
    const m = tk.match(SIZE_RE);
    if (m && tk.length <= 6) { size = m[1]; continue; }
    if (VALUE_RE.test(tk)) { value = normValue(tk); continue; }
    const word = KIND_WORDS.find(([re]) => re.test(tk));
    if (word) { refHint = word[1]; continue; }
    return null;   // 出现无法归类的词：不是通用件查询
  }
  if (!value && !refHint) return null;

  // 类别判定统一走 PartSemanticClassifier（值 + 位号提示都喂给它）
  const kind = classifyPart({ reference: refHint ?? '', value: value ?? '' }).passiveKind;
  if (!kind) return null;

  const defaults = kicadPassiveDefaults(refHint ?? '', value ?? '', '', size ? `X_${size}_` : '');
  if (!defaults) return null;

  return {
    kind, value, size,
    symbol: defaults.symbol,
    footprint: defaults.footprint,
    label: [value, defaults.footprint].filter(Boolean).join(' · '),
  };
}

/**
 * design-core/semantics/part.ts
 * 器件语义的**唯一**实现（PartSemanticClassifier）。
 *
 * 此前五处各写一套 R/C/L/D/Q/LED/连接器 的正则：
 *   document/services.ts refPrefixFor（生成位号前缀）
 *   modules/bom/part-class.ts classifyByRefDes（BOM 估价分类）
 *   design-core/part-matching.ts classFromReference（选型匹配）
 *   geometry/kicad-passive-defaults.ts classifyPassive（默认符号/封装）
 *   component-search/sub-circuit.ts 里的无源判定
 * 判定顺序、别名覆盖各不相同，同一颗料在 BOM 与选型里可能得到不同类别。
 *
 * 现在只在这里判，其余模块调用 classifyPart() 后各取所需字段。
 * 证据优先级：封装名/值/描述（最具体）> 位号前缀 > 抽象类别（兜底）。
 */
import type { ComponentCategory } from '../document/types';

export type PartClass =
  | 'resistor' | 'capacitor' | 'inductor' | 'ferrite' | 'diode' | 'led' | 'transistor'
  | 'ic' | 'connector' | 'crystal' | 'switch' | 'fuse' | 'buzzer' | 'relay' | 'battery'
  | 'module' | 'testpoint' | 'mounting' | 'unknown';

/** 无源件细分（默认符号/封装用）；非无源为 undefined */
export type PassiveKind = 'capacitor' | 'resistor' | 'inductor' | 'ferrite' | 'led'
  | 'diode' | 'schottky' | 'zener' | 'tvs' | 'crystal' | 'fuse';

export interface PartEvidence {
  reference?: string;
  value?: string;
  mpn?: string;
  footprint?: string;
  description?: string;
  category?: ComponentCategory | string;
}

export interface PartSemantics {
  class: PartClass;
  passiveKind?: PassiveKind;
  /** KiCad 习惯的位号前缀 */
  defaultRefPrefix: string;
  /** 是否值得向分销商询价（结构件/测试点从不） */
  priceable: boolean;
  /** KiCad 官方默认符号（无源件） */
  defaultSymbol?: string;
  /** 依据来自哪一层证据（便于解释与调试） */
  evidence: 'footprint' | 'value' | 'reference' | 'category' | 'none';
}

const CLASS_PREFIX: Record<PartClass, string> = {
  resistor: 'R', capacitor: 'C', inductor: 'L', ferrite: 'FB', diode: 'D', led: 'D', transistor: 'Q',
  ic: 'U', connector: 'J', crystal: 'Y', switch: 'SW', fuse: 'F', buzzer: 'BZ', relay: 'K', battery: 'BT',
  module: 'U', testpoint: 'TP', mounting: 'H', unknown: 'U',
};

const CATEGORY_CLASS: Record<string, PartClass> = {
  mcu: 'ic', power: 'ic', ic: 'ic', sensor: 'ic', rf: 'ic', module: 'module',
  passive: 'resistor', connector: 'connector', electromech: 'switch',
};

const SYMBOL: Partial<Record<PassiveKind, string>> = {
  capacitor: 'Device:C_Small', resistor: 'Device:R_Small', inductor: 'Device:L_Small',
  ferrite: 'Device:FerriteBead_Small', led: 'Device:LED_Small', diode: 'Device:D_Small',
  schottky: 'Device:D_Schottky_Small', zener: 'Device:D_Zener_Small', tvs: 'Device:D_TVS',
  crystal: 'Device:Crystal_Small', fuse: 'Device:Fuse_Small',
};

/** 值/描述/封装/型号级规则：按具体度排序，先命中先得 */
const HAY_RULES: [RegExp, PartClass, PassiveKind?][] = [
  // 具体器件族先判（含明确关键字），再判无源件；无源件的封装前缀只在**词首**匹配，
  // 否则 USB_C_Receptacle 里的 "_C_" 会被当成电容
  [/TVS|ESD|瞬态/i, 'diode', 'tvs'],
  [/SCHOTTKY|肖特基/i, 'diode', 'schottky'],
  [/ZENER|齐纳|稳压二极管/i, 'diode', 'zener'],
  [/^LED_|_LED\b|\bLED\b|发光/i, 'led', 'led'],
  [/CONN|PINHEADER|PINSOCKET|USB|插座|端子|排针|排母|连接器|TERMINAL|JST|XH-|PH-|RECEPTACLE/i, 'connector'],
  [/(^|\s)SW_|SWITCH|BUTTON|按键|开关|轻触|TACT/i, 'switch'],
  [/MOUNTINGHOLE|MOUNTING_HOLE|定位孔|安装孔/i, 'mounting'],
  [/TESTPOINT|TEST_POINT|测试点/i, 'testpoint'],
  [/(^|\s)FB_|FERRITE|铁氧体|磁珠|(^|\s)BLM\d/i, 'ferrite', 'ferrite'],
  [/CRYSTAL|XTAL|晶振|谐振|OSC(?!ILLOSCOPE)|\d+(\.\d+)?\s*MHZ/i, 'crystal', 'crystal'],
  [/FUSE|保险丝|POLYFUSE|(^|\s)PTC/i, 'fuse', 'fuse'],
  [/BUZZER|蜂鸣/i, 'buzzer'],
  [/RELAY|继电器/i, 'relay'],
  [/BATTERY|电池|(^|\s)BT_/i, 'battery'],
  [/(^|\s)Q_|MOSFET|NPN|PNP|三极管|晶体管|TRANSISTOR|(^|\s)(BSS|IRF|AO\d)/i, 'transistor'],
  [/(^|\s)(D_|SOD)|(^|\s)1N\d|DIODE|二极管|整流/i, 'diode', 'diode'],
  [/(^|\s)(R_|RES\b)|电阻|RESISTOR|\d+(?:\.\d+)?\s*[KkMm]?\s*(?:Ω|OHM)|^\d+(?:\.\d+)?[KkMmR](?:\d+)?$/i, 'resistor', 'resistor'],
  [/(^|\s)(C_|CP_|CAP\b)|电容|MLCC|CAPACITOR|\d\s*(uF|nF|pF|μF)\b/i, 'capacitor', 'capacitor'],
  [/(^|\s)(L_|IND\b)|电感|INDUCTOR|\d\s*(nH|uH|mH|μH)\b/i, 'inductor', 'inductor'],
];

/** 位号前缀 → 类别（KiCad/IPC 通用约定；LED/DS 排在 D/L 之前） */
const REF_RULES: [RegExp, PartClass, PassiveKind?][] = [
  [/^LED\d/i, 'led', 'led'], [/^DS\d/i, 'led', 'led'],
  [/^RN\d/i, 'resistor', 'resistor'], [/^RV\d/i, 'resistor', 'resistor'], [/^R\d/i, 'resistor', 'resistor'],
  [/^CP\d/i, 'capacitor', 'capacitor'], [/^C\d/i, 'capacitor', 'capacitor'],
  [/^FB\d/i, 'ferrite', 'ferrite'], [/^FL\d/i, 'ferrite', 'ferrite'], [/^L\d/i, 'inductor', 'inductor'],
  [/^ZD\d/i, 'diode', 'zener'], [/^(D|CR)\d/i, 'diode', 'diode'],
  [/^(Q|T)\d/i, 'transistor'],
  [/^(U|IC)\d/i, 'ic'],
  [/^(J|P|CN|CON)\d/i, 'connector'],
  [/^(Y|X|XTAL)\d/i, 'crystal', 'crystal'],
  [/^(SW|S|K)\d/i, 'switch'],
  [/^(F|FU)\d/i, 'fuse', 'fuse'],
  [/^BZ\d/i, 'buzzer'], [/^BT\d/i, 'battery'],
  [/^(M|MOD)\d/i, 'module'],
  [/^TP\d/i, 'testpoint'],
  [/^(H|MH|MK)\d/i, 'mounting'],
];

const NEVER_PRICED = new Set<PartClass>(['mounting', 'testpoint']);

/** 唯一入口 */
export function classifyPart(ev: PartEvidence): PartSemantics {
  const ref = (ev.reference ?? '').trim().toUpperCase();
  const fp = (ev.footprint ?? '').trim();
  const hayStrong = `${fp} ${ev.value ?? ''} ${ev.description ?? ''} ${ev.mpn ?? ''}`.trim();

  let cls: PartClass | undefined; let kind: PassiveKind | undefined; let evidence: PartSemantics['evidence'] = 'none';

  // 1) 封装/值/描述/型号：最具体的证据（LED_0603 就是 LED，哪怕位号写 D）
  if (hayStrong) {
    for (const [re, c, k] of HAY_RULES) {
      if (re.test(hayStrong)) { cls = c; kind = k; evidence = /^LED_|_LED|SOD|SOT|_\d{4}_|Metric/i.test(fp) && re.test(fp) ? 'footprint' : 'value'; break; }
    }
  }
  // 2) 位号前缀
  if (!cls && ref) {
    for (const [re, c, k] of REF_RULES) if (re.test(ref)) { cls = c; kind = k; evidence = 'reference'; break; }
  }
  // 3) 抽象类别兜底
  if (!cls && ev.category) {
    const c = CATEGORY_CLASS[String(ev.category).toLowerCase()];
    if (c) { cls = c; evidence = 'category'; if (c === 'resistor') kind = undefined; }
  }
  const finalClass: PartClass = cls ?? 'unknown';
  // 位号前缀：LED 也用 D（KiCad 习惯）；抽象类别 passive 却没细分时给 R
  const defaultRefPrefix = CLASS_PREFIX[finalClass];
  return {
    class: finalClass, passiveKind: kind, defaultRefPrefix,
    priceable: !NEVER_PRICED.has(finalClass),
    defaultSymbol: kind ? SYMBOL[kind] : undefined,
    evidence,
  };
}

/** 类别中文名（UI 与检索提示词共用） */
export const PART_CLASS_LABEL: Record<PartClass, string> = {
  resistor: '电阻', capacitor: '电容', inductor: '电感', ferrite: '磁珠', diode: '二极管', led: 'LED',
  transistor: '晶体管', ic: '集成电路', connector: '连接器', crystal: '晶振/谐振器', switch: '开关/按键',
  fuse: '保险丝', buzzer: '蜂鸣器', relay: '继电器', battery: '电池', module: '模块',
  testpoint: '测试点', mounting: '安装件', unknown: '未分类',
};

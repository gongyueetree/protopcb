/**
 * design-core/geometry/kicad-passive-defaults.ts
 * 无源器件的 KiCad 官方库默认符号与封装。
 *
 * 为什么要固定下来：AI 给电容/电阻这类无源件时，型号五花八门（"100nF"、"0.1uF"、
 * "CC0402KRX7R9BB104"），符号和封装如果也跟着漂，画布上就会出现同一种电容
 * 三种画法。这些器件的官方画法是明确且唯一的，直接钉死：
 *   电容 → Device:C_Small + C_0402_1005Metric
 *   电阻 → Device:R_Small + R_0402_1005Metric
 * 其余（电感、LED、二极管、晶振…）同理。
 *
 * 只对**能确定类别**的无源件生效；判不出来就返回 undefined，交给原有流程。
 */

export type PassiveKind = 'capacitor' | 'resistor' | 'inductor' | 'ferrite' | 'led'
  | 'diode' | 'schottky' | 'zener' | 'tvs' | 'crystal' | 'fuse';

export interface PassiveDefaults {
  kind: PassiveKind;
  /** KiCad 官方符号库的 `库:符号名` */
  symbol: string;
  /** KiCad 官方封装名（默认尺寸；若已知实际尺寸代号则替换其中的尺寸段） */
  footprint: string;
}

/** 符号：KiCad 官方 Device / LED 库里的标准画法 */
const SYMBOL: Record<PassiveKind, string> = {
  capacitor: 'Device:C_Small',
  resistor: 'Device:R_Small',
  inductor: 'Device:L_Small',
  ferrite: 'Device:FerriteBead_Small',
  led: 'Device:LED_Small',
  diode: 'Device:D_Small',
  schottky: 'Device:D_Schottky_Small',
  zener: 'Device:D_Zener_Small',
  tvs: 'Device:D_TVS',
  crystal: 'Device:Crystal_Small',
  fuse: 'Device:Fuse_Small',
};

/** 封装：尺寸代号 → KiCad 公制封装名的后缀（0402 = 公制 1005） */
const METRIC: Record<string, string> = {
  '0201': '0603Metric', '0402': '1005Metric', '0603': '1608Metric',
  '0805': '2012Metric', '1206': '3216Metric', '1210': '3225Metric',
  '1812': '4532Metric', '2010': '5025Metric', '2512': '6332Metric',
};

const FP_PREFIX: Partial<Record<PassiveKind, string>> = {
  capacitor: 'C', resistor: 'R', inductor: 'L', ferrite: 'L', led: 'LED',
};

const DEFAULT_SIZE = '0402';

/** 非片式器件的默认封装（没有尺寸代号概念） */
const FIXED_FP: Partial<Record<PassiveKind, string>> = {
  diode: 'D_SOD-123',
  schottky: 'D_SOD-123',
  zener: 'D_SOD-123',
  tvs: 'D_SOD-323',
  crystal: 'Crystal_SMD_3225-4Pin_3.2x2.5mm',
  fuse: 'Fuse_1206_3216Metric',
};

/** 由位号 + 值/型号 + 描述判断无源件类别；判不出返回 undefined（不硬猜） */
export function classifyPassive(reference: string, value: string, description = ''): PassiveKind | undefined {
  const ref = (reference ?? '').toUpperCase();
  const hay = `${value ?? ''} ${description ?? ''}`.toUpperCase();

  // TVS / 肖特基 / 稳压管要在普通二极管之前判，否则会被 D 位号吞掉
  if (/TVS|ESD|瞬态/.test(hay)) return 'tvs';
  if (/SCHOTTKY|肖特基/.test(hay)) return 'schottky';
  if (/ZENER|齐纳|稳压二极管/.test(hay)) return 'zener';
  if (/^LED\d|LED/.test(ref) || /\bLED\b|发光二极管/.test(hay)) return 'led';
  if (/^(FB|FL)\d/.test(ref) || /FERRITE|磁珠/.test(hay)) return 'ferrite';
  if (/^C\d/.test(ref) || /\d\s*(PF|NF|UF|ΜF)\b/.test(hay) || /CAPACITOR|电容/.test(hay)) return 'capacitor';
  if (/^R\d/.test(ref) || /\d\s*(Ω|OHM|[KM]Ω?)\b/.test(hay) || /RESISTOR|电阻/.test(hay)) return 'resistor';
  if (/^L\d/.test(ref) || /\d\s*(NH|UH|MH)\b/.test(hay) || /INDUCTOR|电感/.test(hay)) return 'inductor';
  if (/^(D|ZD)\d/.test(ref) || /DIODE|二极管/.test(hay)) return 'diode';
  if (/^(Y|X|XTAL)\d/.test(ref) || /CRYSTAL|晶振|MHZ/.test(hay)) return 'crystal';
  if (/^F\d/.test(ref) || /FUSE|保险丝/.test(hay)) return 'fuse';
  return undefined;
}

/** 从已有封装名里提取尺寸代号（0402 等），用于保留设计者已指定的尺寸 */
export function sizeCodeOf(footprint: string): string | undefined {
  const m = (footprint ?? '').match(/(?<![0-9])(0201|0402|0603|0805|1206|1210|1812|2010|2512)(?![0-9])/);
  return m?.[1];
}

/**
 * 取该器件应使用的 KiCad 官方默认符号与封装。
 * @param existingFootprint 已有封装名（有尺寸代号就沿用，避免把 0805 改成 0402）
 */
export function kicadPassiveDefaults(
  reference: string, value: string, description = '', existingFootprint = '',
): PassiveDefaults | undefined {
  const kind = classifyPassive(reference, value, description);
  if (!kind) return undefined;
  const prefix = FP_PREFIX[kind];
  if (!prefix) return { kind, symbol: SYMBOL[kind], footprint: FIXED_FP[kind] ?? 'C_0402_1005Metric' };
  const size = sizeCodeOf(existingFootprint) ?? DEFAULT_SIZE;
  return { kind, symbol: SYMBOL[kind], footprint: `${prefix}_${size}_${METRIC[size]}` };
}

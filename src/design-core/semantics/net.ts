/**
 * design-core/semantics/net.ts
 * 网络语义分类的**唯一**实现（NetSemanticClassifier）。
 *
 * 此前有两套：fragment/extract.ts 刻意不把 VIN/VOUT 当电源（DAC/运放上它们是模拟信号），
 * block-diagram/from-netlist.ts 的 POWER_NAME 却包含 VIN/VOUT —— 同一网络两种判定。
 *
 * 策略：不只看网络名。综合
 *   - 网络名（GND/VCC/+3V3 这类无歧义前缀）
 *   - 连到它的引脚电气类型（power_in/power_out 占多数 → POWER）
 *   - 连到它的器件类别（电源类 IC 的 VIN/VOUT 才是电源轨）
 *   - 扇出（高扇出的电压名更像电源轨）
 * 不确定就 UNKNOWN，禁止过度猜测。
 */

export type NetKind = 'GROUND' | 'POWER' | 'ANALOG' | 'DIGITAL' | 'CLOCK' | 'BUS' | 'DIFF_PAIR' | 'UNKNOWN';

export interface NetPinEvidence {
  /** 引脚电气类型（KiCad 风格），可缺失 */
  pinType?: string;
  /** 所属器件类别 */
  componentCategory?: string;
  /** 引脚名（如 VIN、SCLK） */
  pinName?: string;
}

export interface NetEvidence {
  name: string;
  pins?: NetPinEvidence[];
}

const GROUND_RE = /^(GND|AGND|DGND|PGND|GNDA|GNDD|GROUND|VSS|VSSA|0V)(\b|_|$)/i;
/** 无歧义的电源名：带电压值或 VCC/VDD/VBUS/VBAT */
const POWER_NAME_RE = /^(\+?\d+V\d*|[+-]\d+(\.\d+)?V\d*|VCC|VDD|VDDA|AVDD|DVDD|VBUS|VBAT|VREF|VSYS|3V3|5V0?|12V)(\b|_|$)/i;
/** 歧义名：只有在电源类器件或电源引脚占多数时才算电源 */
const AMBIGUOUS_POWER_RE = /^(VIN|VOUT|VI|VO|V\+|V-|PVIN|SW)(\b|_|$)/i;
const CLOCK_RE = /(^|_)(CLK|XTAL|OSC|MCLK|SCLK|BCLK|LRCLK|XIN|XOUT|HCLK)(\b|_|\d|$)/i;
const DIFF_RE = /(_P|_N|_DP|_DM|\+|-)$|^(USB_D[PM]|D[PM]|USB_[PN])$|(TX|RX)[PN]\d*$|LVDS/i;
const BUS_RE = /^(SPI|I2C|I2S|UART|CAN|SDIO|QSPI|SD_|MOSI|MISO|SCK|SDA|SCL|D\d+$|A\d+$|DATA\d*|ADDR\d*|ADC_D\d)/i;
const ANALOG_RE = /^(AIN|AOUT|ADC|DAC|VREF|SENSE|FB|COMP|ISNS|VSNS|TEMP|IN[AB][+-]?|OUT[AB]?)(\b|_|\d|$)/i;

/** 纯名称判定（没有引脚证据时的下限） */
export function classifyNetByName(name: string): NetKind {
  const n = (name ?? '').trim();
  if (!n) return 'UNKNOWN';
  if (GROUND_RE.test(n)) return 'GROUND';
  if (POWER_NAME_RE.test(n)) return 'POWER';
  if (DIFF_RE.test(n) && /D[PM]|_[PN]$|LVDS|[TR]X[PN]/i.test(n)) return 'DIFF_PAIR';
  if (CLOCK_RE.test(n) && !/SCL$/i.test(n)) return 'CLOCK';
  if (BUS_RE.test(n)) return 'BUS';
  if (ANALOG_RE.test(n)) return 'ANALOG';
  // VIN/VOUT 这类歧义名：名称本身给不出结论
  return 'UNKNOWN';
}

/**
 * 综合判定。引脚证据存在时优先于名称启发。
 */
export function classifyNet(ev: NetEvidence): NetKind {
  const byName = classifyNetByName(ev.name);
  const pins = ev.pins ?? [];
  if (byName === 'GROUND') return 'GROUND';

  if (pins.length) {
    const types = pins.map((p) => (p.pinType ?? '').toLowerCase());
    const powerPins = types.filter((t) => t === 'power_in' || t === 'power_out').length;
    const powerOutPresent = types.includes('power_out');
    const onPowerDevice = pins.some((p) => (p.componentCategory ?? '').toLowerCase() === 'power');
    // 有电源输出脚驱动、且电源脚占多数 → 电源轨（哪怕名字叫 VOUT）
    if (powerOutPresent && powerPins >= Math.ceil(pins.length / 2)) return 'POWER';
    // 歧义名 + 挂在电源类器件上 → 电源
    if (AMBIGUOUS_POWER_RE.test(ev.name) && onPowerDevice && powerPins > 0) return 'POWER';
    // 歧义名但全是无源/模拟脚 → 模拟信号（DAC/运放的 VOUT）
    if (AMBIGUOUS_POWER_RE.test(ev.name) && powerPins === 0) return 'ANALOG';
  }
  if (byName !== 'UNKNOWN') return byName;
  // 歧义名、无引脚证据：高扇出更像电源轨，但仍不猜 —— 返回 UNKNOWN 让调用方决定
  return 'UNKNOWN';
}

/** 供旧调用方使用的粗粒度映射（fragment 只区分 4 类） */
export function toCoarseKind(k: NetKind): 'SIGNAL' | 'POWER' | 'GROUND' | 'CLOCK' {
  if (k === 'POWER' || k === 'GROUND' || k === 'CLOCK') return k;
  return 'SIGNAL';
}

/** 是否"人人都连"的公共轨（电源/地）—— 归属/桥接算法据此排除 */
export const isCommonRail = (k: NetKind) => k === 'POWER' || k === 'GROUND';

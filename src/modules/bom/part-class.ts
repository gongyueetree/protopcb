/**
 * 位号分类与"是否可估价"判定。
 *
 * BOM 估价的核心风险：把"值"当成"型号"去查分销商。
 * 例如 D1 的值是 STA（丝印代号）、封装 LED_0603，拿 STA 去关键词检索
 * 会命中完全无关的贵价料（实测出现过 1800 美元的二极管）。
 *
 * 因此估价前必须先判定类别与型号可信度：
 *   - 位号前缀给出器件类别（U=IC，Q=晶体管，D=二极管，R/C/L=无源…）
 *   - 只有"看起来像真实厂商料号"的才发查询；否则不查、显示 —
 *   - 无源件即使有料号，也要求料号形态足够具体（避免 10K/100nF 这类值）
 */

export type PartClass = 'ic' | 'transistor' | 'diode' | 'led' | 'resistor' | 'capacitor'
  | 'inductor' | 'crystal' | 'connector' | 'switch' | 'fuse' | 'module' | 'mechanical' | 'other';

/** 位号前缀 → 类别（KiCad/IPC 通用约定） */
export function classifyByRefDes(reference: string, footprint = '', value = ''): PartClass {
  const p = (reference.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
  const fp = footprint.toUpperCase();
  // 封装名比位号更可靠时优先（LED_0603 明确是 LED，即使位号写 D）
  if (/^LED_|_LED/.test(fp) || /\bLED\b/i.test(value)) return 'led';
  switch (p) {
    case 'U': case 'IC': return 'ic';
    case 'Q': return 'transistor';
    case 'D': case 'CR': return /LED/i.test(fp + value) ? 'led' : 'diode';
    case 'R': case 'RN': case 'RV': return 'resistor';
    case 'C': return 'capacitor';
    case 'L': case 'FB': return 'inductor';
    case 'Y': case 'X': case 'XTAL': return 'crystal';
    case 'J': case 'P': case 'CN': return 'connector';
    case 'SW': case 'S': case 'K': return 'switch';
    case 'F': return 'fuse';
    case 'M': case 'MOD': return 'module';
    case 'H': case 'MH': case 'TP': return 'mechanical';
    default: return 'other';
  }
}

/** 类别中文名（界面显示与检索提示词用） */
export const CLASS_LABEL: Record<PartClass, string> = {
  ic: 'IC', transistor: '晶体管', diode: '二极管', led: 'LED', resistor: '电阻',
  capacitor: '电容', inductor: '电感/磁珠', crystal: '晶振', connector: '连接器',
  switch: '开关', fuse: '保险丝', module: '模块', mechanical: '结构件', other: '其它',
};

/** 结构件（定位孔、测试点）从不估价 */
const NEVER_PRICED: PartClass[] = ['mechanical'];

/**
 * 该行是否值得向分销商发起查询。
 * 判定思路：宁可不报价，也不要报错价 —— 错价格比没价格更有害。
 */
export function isPriceable(mpn: string, reference: string, footprint = ''): boolean {
  const cls = classifyByRefDes(reference, footprint, mpn);
  if (NEVER_PRICED.includes(cls)) return false;

  const m = (mpn ?? '').trim();
  if (m.length < 4) return false;                       // STA、10K、1uF…
  if (/[\u4e00-\u9fff]/.test(m)) return false;          // 中文描述不是料号
  if (/^(fp_|CUSTOM_|sub_)/i.test(m)) return false;     // 占位/自建/子电路通用件
  if (/^UNKNOWN$/i.test(m)) return false;

  // 纯元件值（10K / 4.7uF / 8MHz / 100nF / 1N/A）不是料号
  if (/^\d+(\.\d+)?\s*(pF|nF|uF|µF|mF|F|R|K|M|Ω|ohm|kΩ|MΩ|nH|uH|mH|H|MHz|kHz|Hz|V|mA|A|W|%)$/i.test(m)) return false;
  if (/^\d+(\.\d+)?[RKM]\d*$/i.test(m)) return false;   // 4K7、10R、1M5 电阻值写法

  // 真实料号形态：含字母且含数字，长度足够
  if (!/[A-Za-z]/.test(m) || !/\d/.test(m)) return false;

  return true;
}

/** 不可估价的原因（界面提示用，让用户知道为什么没价格） */
export function whyNotPriceable(mpn: string, reference: string, footprint = ''): string | null {
  if (isPriceable(mpn, reference, footprint)) return null;
  const cls = classifyByRefDes(reference, footprint, mpn);
  if (NEVER_PRICED.includes(cls)) return '结构件无需采购';
  const m = (mpn ?? '').trim();
  if (!m || m.length < 4) return '缺少明确型号';
  if (/^\d+(\.\d+)?\s*(pF|nF|uF|Ω|ohm|K|M|MHz|kHz|V|A|W)$/i.test(m) || /^\d+(\.\d+)?[RKM]\d*$/i.test(m)) {
    return '这是元件值不是型号';
  }
  return '型号不完整，无法精确匹配';
}

/** 估价顺序：IC/模块最贵最需要，优先查；结构件根本不查 */
export function pricingPriority(cls: PartClass): number {
  const order: PartClass[] = ['ic', 'module', 'transistor', 'diode', 'led', 'crystal',
    'connector', 'switch', 'fuse', 'inductor', 'capacitor', 'resistor', 'other', 'mechanical'];
  const i = order.indexOf(cls);
  return i < 0 ? order.length : i;
}

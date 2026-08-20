/**
 * 子电路推荐 —— 围绕核心器件，由大模型给出高度相关的周边器件
 * （相当于 datasheet 应用框图 / 典型参考设计的提取）：
 *   - 去耦/滤波电容、上拉/限流电阻、晶振及负载电容、复位电路、接口保护……
 *   - 无源器件默认 0603 封装（R_0603_1608Metric / C_0603_1608Metric / L_0603_1608Metric）
 *   - 每项标注连接的核心管脚（如 VDD、XTAL1），一键上画布时按管脚顺序围核心排布
 */
import { geminiComplete, extractJson, geminiAvailable } from '../../providers/gemini';
import type { ComponentCategory } from '../../design-core/document/types';

export interface SubCircuitItem {
  /** 作用角色，如「VDD 去耦」「复位上拉」 */
  role: string;
  /** 型号或通用值（100nF / 10kΩ / 8MHz 晶振 / 具体 MPN） */
  value: string;
  mpn?: string;
  category: ComponentCategory;
  /** KiCad 封装名（无源件默认 0603 系列） */
  footprint: string;
  /** 连接到核心器件的管脚名（用于围核心按管脚序排布） */
  connectsTo: string;
  qty: number;
}

const PASSIVE_0603: Record<string, string> = {
  R: 'R_0603_1608Metric',
  C: 'C_0603_1608Metric',
  L: 'L_0603_1608Metric',
  LED: 'LED_0603_1608Metric',
  D: 'D_SOD-123',
};

/** 规范化 AI 输出：无源件强制 0603 系、类别兜底、数量钳制 */
function normalize(items: Partial<SubCircuitItem>[]): SubCircuitItem[] {
  const out: SubCircuitItem[] = [];
  for (const it of items) {
    if (!it || !it.role || !it.value) continue;
    const val = String(it.value);
    let cat = (it.category as ComponentCategory) ?? 'passive';
    let fp = String(it.footprint ?? '');
    const isR = /Ω|ohm|电阻|^R\b/i.test(val) || /电阻|resistor/i.test(it.role ?? '');
    const isC = /F$|uF|nF|pF|电容/i.test(val) || /电容|去耦|滤波|capacitor/i.test(it.role ?? '');
    const isL = /H$|uH|nH|电感|磁珠/i.test(val);
    const isLed = /LED|发光/i.test(val + (it.role ?? ''));
    const isD = /二极管|diode|TVS|肖特基/i.test(val + (it.role ?? ''));
    if (isR || isC || isL || isLed || isD) {
      cat = 'passive';
      // 无源件默认 0603（用户约定），除非 AI 给了同族里更具体的合法名
      const dft = isLed ? PASSIVE_0603.LED : isD ? PASSIVE_0603.D : isR ? PASSIVE_0603.R : isL ? PASSIVE_0603.L : PASSIVE_0603.C;
      if (!/^(R|C|L|LED|D)_\d{4}_\d{4}Metric$|^D_SOD/.test(fp)) fp = dft;
    } else if (/晶振|crystal|xtal/i.test(val + (it.role ?? ''))) {
      cat = 'passive';
      if (!fp) fp = 'Crystal_SMD_3225-4Pin_3.2x2.5mm';
    } else if (!fp) {
      fp = 'SOT-23';
    }
    out.push({
      role: String(it.role).slice(0, 30),
      value: val.slice(0, 40),
      mpn: it.mpn ? String(it.mpn).slice(0, 40) : undefined,
      category: cat,
      footprint: fp,
      connectsTo: String(it.connectsTo ?? '').slice(0, 20) || '—',
      qty: Math.max(1, Math.min(8, Number(it.qty) || 1)),
    });
  }
  return out.slice(0, 15);
}

export async function recommendSubCircuit(core: {
  mpn: string;
  manufacturer?: string;
  description?: string;
}): Promise<SubCircuitItem[]> {
  if (!(await geminiAvailable())) throw new Error('未配置 Gemini（GEMINI_API_KEY）');
  const raw = await geminiComplete(
    `核心器件：${core.mpn}（${core.manufacturer ?? ''} ${core.description ?? ''}）。\n` +
    `请依据该器件 datasheet 的典型应用电路（Typical Application）与常见参考设计，列出让它正常工作所需的周边器件：\n` +
    `去耦/滤波电容、上拉下拉电阻、晶振及负载电容、复位电路、必要的接口保护等。\n` +
    `要求：\n` +
    `1. 只列真实需要的，不凑数；同值多只的用 qty 表示\n` +
    `2. 无源器件不指定具体厂商型号，给通用值（如 100nF、10kΩ）\n` +
    `3. connectsTo 填该器件连到核心的管脚名（VDD/GND/XTAL1/RST/EN 等）\n` +
    `严格输出 JSON 数组，不要其他文字：\n` +
    `[{"role":"作用","value":"值或型号","category":"passive|ic|power|connector","footprint":"KiCad封装名可留空","connectsTo":"核心管脚名","qty":1}]`,
  );
  const items = normalize(extractJson<Partial<SubCircuitItem>[]>(raw));
  if (!items.length) throw new Error('AI 未给出有效的子电路建议');
  return items;
}

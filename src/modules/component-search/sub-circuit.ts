/**
 * 子电路推荐 —— 围绕核心器件，由大模型给出高度相关的周边器件
 * （相当于 datasheet 应用框图 / 典型参考设计的提取）：
 *   - 去耦/滤波电容、上拉/限流电阻、晶振及负载电容、复位电路、接口保护……
 *   - 无源器件默认 0603 封装（R_0603_1608Metric / C_0603_1608Metric / L_0603_1608Metric）
 *   - 每项标注连接的核心管脚（如 VDD、XTAL1），一键上画布时按管脚顺序围核心排布
 */
import { geminiAvailable } from '../../providers/gemini';
import { aiRequest, extractJson } from '../../providers/ai-client';
import { curLang } from '../../shared/i18n';
import { AiSubCircuitSchema, validateAi } from '../../providers/ai-schema';
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
    // 电源轨不是元器件：+5V/-5V/GND/VCC/VDD 之类在原理图里用电源符号表达，不上画布
    if (/^[+\-±]?\d+(\.\d+)?\s*V$/i.test(val.trim()) || /^(GND|VCC|VDD|VSS|VEE|AGND|DGND|VBUS)$/i.test(val.trim())
      || /电源轨|power rail/i.test(it.role ?? '')) continue;
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
  // 服务端拼 prompt、固定计费；这里只发结构化输入
  const raw = (await aiRequest('subcircuit.recommend', {
    mpn: core.mpn, manufacturer: core.manufacturer, description: core.description, lang: curLang(),
  })).text;
  // 先过 Zod：结构不符直接整条拒绝，不让半成品污染画布
  const parsed = validateAi(AiSubCircuitSchema, extractJson<unknown>(raw), '子电路推荐');
  if (!parsed.ok) throw new Error(parsed.error);
  const items = normalize(parsed.data as Partial<SubCircuitItem>[]);
  if (!items.length) throw new Error('AI 未给出有效的子电路建议');
  return items;
}

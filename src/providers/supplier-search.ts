/**
 * 分销商器件检索（DigiKey / Mouser）+ 封装名自动映射
 *
 * 分销商返回的封装字段是"行业口径"（0402 / SOT-23-5 / SOIC-8），
 * 与 KiCad 标准封装名（R_0402_1005Metric / Package_TO_SOT_SMD:SOT-23-5）不同。
 * 这里做确定性映射，使检索到的器件能直接落到画布并拥有精确焊盘与 3D。
 */
import type { ComponentSearchResult } from './types';
import type { ComponentCategory } from '../design-core/document/types';

export interface SupplierPart {
  mpn: string;
  manufacturer: string;
  description?: string;
  /** 分销商原始封装描述 */
  rawPackage?: string;
  /** 映射后的 KiCad 封装名（映射失败为 undefined） */
  footprintName?: string;
  price?: number;
  currency?: string;
  stock?: number;
  url?: string;
  vendor: string;
  datasheetUrl?: string;
}

/** 类别推断：按描述/型号关键词（决定位号前缀与符号族） */
function guessCategory(text: string): ComponentCategory {
  const t = text.toLowerCase();
  if (/microcontroller|mcu|单片机/.test(t)) return 'mcu';
  if (/regulator|ldo|dc-dc|buck|boost|稳压|电源管理/.test(t)) return 'power';
  if (/connector|receptacle|header|socket|连接器|插座/.test(t)) return 'connector';
  if (/resistor|capacitor|inductor|电阻|电容|电感|ferrite/.test(t)) return 'passive';
  if (/sensor|传感器/.test(t)) return 'sensor';
  if (/antenna|rf|wifi|bluetooth|射频/.test(t)) return 'rf';
  if (/relay|switch|button|继电器|开关|按键/.test(t)) return 'electromech';
  return 'ic';
}

/**
 * 分销商封装描述 → KiCad 标准封装名。
 * 无源件按尺寸码 + 器件类型拼装（0402 电阻 → R_0402_1005Metric）；
 * IC 按封装族 + 管脚数拼装。映射不到时返回 undefined（宁可留空也不给错封装）。
 */
export function mapToKicadFootprint(rawPackage: string, description: string, mpn: string): string | undefined {
  const pkg = (rawPackage || '').trim();
  const hay = `${pkg} ${description} ${mpn}`.toLowerCase();
  if (!pkg && !description) return undefined;

  // ── 无源件尺寸码（英制 → KiCad 公制命名） ──
  const IMPERIAL: Record<string, string> = {
    '0201': '0603Metric', '0402': '1005Metric', '0603': '1608Metric',
    '0805': '2012Metric', '1206': '3216Metric', '1210': '3225Metric',
    '1812': '4532Metric', '2010': '5025Metric', '2512': '6332Metric',
  };
  const sizeCode = pkg.match(/\b(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b/)?.[1];
  if (sizeCode) {
    const metric = IMPERIAL[sizeCode];
    const prefix =
      /resistor|电阻|\bres\b/.test(hay) ? 'R'
      : /capacitor|电容|\bcap\b|mlcc/.test(hay) ? 'C'
      : /inductor|电感|ferrite|磁珠|\bind\b|\buh\b|\bnh\b/.test(hay) ? 'L'
      : /led|发光/.test(hay) ? 'LED'
      : /diode|二极管/.test(hay) ? 'D'
      : /fuse|保险丝/.test(hay) ? 'Fuse'
      : null;
    if (prefix) return `${prefix}_${sizeCode}_${metric}`;
  }

  // ── 有源件封装族 ──
  const pins = Number(pkg.match(/(\d{1,3})\s*(?:pin|lead|-pin)/i)?.[1] ?? pkg.match(/-(\d{1,3})\b/)?.[1] ?? '') || null;
  const FAMILY: [RegExp, (n: number | null) => string | undefined][] = [
    [/sot-?23-?5|sot23-5/i, () => 'SOT-23-5'],
    [/sot-?23-?6|sot23-6/i, () => 'SOT-23-6'],
    [/sot-?23/i, () => 'SOT-23'],
    [/sot-?89/i, () => 'SOT-89-3'],
    [/sot-?223/i, () => 'SOT-223-3_TabPin2'],
    [/soic|so-?8|sop-?8/i, (n) => (n ? `SOIC-${n}_3.9x4.9mm_P1.27mm` : 'SOIC-8_3.9x4.9mm_P1.27mm')],
    [/tssop/i, (n) => (n ? `TSSOP-${n}_4.4x5mm_P0.65mm` : undefined)],
    [/ssop/i, (n) => (n ? `SSOP-${n}_5.3x10.2mm_P0.65mm` : undefined)],
    [/msop/i, (n) => (n ? `MSOP-${n}_3x3mm_P0.65mm` : undefined)],
    [/lqfp/i, (n) => (n ? `LQFP-${n}_7x7mm_P0.5mm` : undefined)],
    [/tqfp/i, (n) => (n ? `TQFP-${n}_7x7mm_P0.5mm` : undefined)],
    [/qfn/i, (n) => (n ? `QFN-${n}_5x5mm_P0.5mm` : undefined)],
    [/dfn/i, (n) => (n ? `DFN-${n}_3x3mm_P0.5mm` : undefined)],
    [/\bdip-?(\d+)|pdip/i, (n) => (n ? `DIP-${n}_W7.62mm` : undefined)],
    [/to-?220/i, () => 'TO-220-3_Vertical'],
    [/to-?252|dpak/i, () => 'TO-252-2'],
    [/sod-?123/i, () => 'D_SOD-123'],
    [/sod-?323/i, () => 'D_SOD-323'],
    [/sma\b/i, () => 'D_SMA'],
    [/smb\b/i, () => 'D_SMB'],
  ];
  for (const [re, fn] of FAMILY) {
    if (re.test(pkg) || re.test(hay)) {
      const got = fn(pins);
      if (got) return got;
    }
  }
  return undefined;
}

/** 分销商结果 → 画布可用的搜索结果（封装映射失败时仍可放置，走参数化几何） */
export function supplierPartToResult(p: SupplierPart): ComponentSearchResult {
  const cat = guessCategory(`${p.description ?? ''} ${p.mpn}`);
  return {
    componentId: `sup_${p.vendor}_${p.mpn}`.replace(/[^\w-]/g, '_'),
    mpn: p.mpn,
    manufacturer: p.manufacturer,
    category: cat,
    defaultFootprintName: p.footprintName ?? p.rawPackage ?? 'UNKNOWN',
    description: p.description,
    family: cat === 'passive' ? (/resistor|电阻/i.test(p.description ?? '') ? 'Resistor' : 'MLCC') : '分销商检索',
    pins: 2,
    unitPrice: p.price != null ? { amount: p.price, currency: p.currency ?? 'USD' } : undefined,
    datasheetUrl: p.datasheetUrl,
  } as ComponentSearchResult;
}

/** 调用后端聚合检索（DigiKey + Mouser） */
export async function searchSupplierParts(keyword: string, limit = 10): Promise<{ available: boolean; items: SupplierPart[]; message?: string }> {
  const q = keyword.trim();
  if (q.length < 2) return { available: false, items: [] };
  try {
    const r = await fetch(`/api/suppliers?path=search&q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = String((await r.json())?.error ?? msg); } catch { /* 非 JSON */ }
      return { available: false, items: [], message: msg };
    }
    const j = await r.json();
    const items: SupplierPart[] = (Array.isArray(j.items) ? j.items : []).map((x: SupplierPart) => ({
      ...x,
      footprintName: x.footprintName ?? mapToKicadFootprint(x.rawPackage ?? '', x.description ?? '', x.mpn),
    }));
    return { available: true, items, message: j.message };
  } catch (e) {
    return { available: false, items: [], message: (e as Error).message };
  }
}

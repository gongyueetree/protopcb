/**
 * design-core/custom-lib.ts — 定制器件库
 * 用户经向导（AI 提取 / 手工填写）创建的器件：管脚定义 + 封装参数，
 * 存 localStorage；符号注册为覆盖（真实管脚名），封装经合成 KiCad 名走既有解析器
 * （2D 焊盘 / 3D / 导出全链路自动生效）。
 */
import type { ComponentSearchResult } from '../providers/types';
import type { ComponentCategory } from './document/types';
import { registerSymbolOverride, registerFootprintOverride, type ParsedSymbol } from './geometry/lib-file-registry';
import { padFootprintFor, type PadFootprint } from './geometry/footprint-pads';

export const KICAD_PIN_TYPES = [
  'input', 'output', 'bidirectional', 'tri_state', 'passive', 'free',
  'unspecified', 'power_in', 'power_out', 'open_collector', 'open_emitter', 'no_connect',
] as const;
export type KicadPinType = (typeof KICAD_PIN_TYPES)[number];

export type PinSide = 'left' | 'right' | 'top' | 'bottom';
export interface CustomPin { num: string; name: string; type: KicadPinType; desc?: string; side?: PinSide }
export interface ManualPad { num: string; x: number; y: number; w: number; h: number; round?: boolean }
export interface CustomPkg {
  family: 'dual' | 'quad' | 'qfn' | 'header' | 'chip' | 'sot' | 'sod' | 'dpak' | 'to220' | 'bga' | 'manual';
  bodyW: number; bodyH: number; pitch: number;
  /** family='manual' 时：逐焊盘坐标表（继电器等异形器件，坐标相对封装中心，mm） */
  manualPads?: ManualPad[];
  /** 模块轮廓（丝印外形）：焊盘可能只占模块的一部分，轮廓独立指定 */
  outlineW?: number; outlineH?: number;
  /** 焊盘阵列相对轮廓中心的偏移（mm） */
  padsOffsetX?: number; padsOffsetY?: number;
}
export interface CustomPart {
  id: string;
  mpn: string;
  description?: string;
  category: ComponentCategory;
  pins: CustomPin[];
  pkg: CustomPkg;
  footprintName: string;
  createdAt: number;
}

const LS_KEY = 'cc_custom_parts';
/** 环境安全的存取（node/SSR 下无 localStorage 时退化为内存） */
const mem: Record<string, string> = {};
const store = {
  get: (k: string): string | null => (typeof localStorage !== 'undefined' ? localStorage.getItem(k) : mem[k] ?? null),
  set: (k: string, v: string) => { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); else mem[k] = v; },
};

/** 封装参数 → 合成 KiCad 规范名（既有名字解析器直接生成真实焊盘） */
export function synthFootprintName(pkg: CustomPkg, pinCount: number): string {
  const dims = `${pkg.bodyW}x${pkg.bodyH}mm_P${pkg.pitch}mm`;
  switch (pkg.family) {
    case 'manual': return `MANUAL-${pinCount}`; // 实际注册名走 customFootprintName（CUSTOM_型号）
    case 'dual': return `SOP-${pinCount}_${dims}`;
    case 'quad': return `QFP-${pinCount}_${dims}`;
    case 'qfn': return `QFN-${pinCount}_${dims}`;
    case 'header': return `PinHeader_1x${String(pinCount).padStart(2, '0')}_P${pkg.pitch}mm`;
    case 'chip': return pkg.bodyW >= 3 ? '1206' : pkg.bodyW >= 1.9 ? '0805' : pkg.bodyW >= 1.4 ? '0603' : '0402';
    // 小外形三极管族：脚数决定具体变体（3/5/6/8 脚均支持，奇数脚正是 SOT 的常态）
    case 'sot': return pkg.bodyW <= 1.5 ? `SC-70-${pinCount}` : pinCount === 4 ? 'SOT-223' : `SOT-23-${pinCount}`;
    case 'sod': return pkg.bodyW >= 2.2 ? 'SOD-123' : 'SOD-323';
    case 'dpak': return `TO-252-${pinCount}`;
    case 'to220': return `TO-220-${pinCount}`;
    case 'bga': return `BGA-${pinCount}_${dims}`;
  }
}

/** 按管脚名/属性推断默认边（电源上、地下、输入左、输出右）——用户可在向导中改 */
export function defaultSide(p: CustomPin): PinSide {
  const n = p.name.toUpperCase();
  if (/^(GND|VSS|AGND|DGND|PGND|GROUND)/.test(n)) return 'bottom';
  if (p.type === 'power_in' || /^(VCC|VDD|VIN|VBAT|AVDD|3V3|5V)/.test(n)) return 'top';
  if (p.type === 'output' || p.type === 'power_out' || /^(OUT|VOUT|TX|MISO)/.test(n)) return 'right';
  if (p.type === 'input' || /^(IN|VIN|RX|MOSI|CLK|SCL|SCK|EN|NRST|RESET)/.test(n)) return 'left';
  return 'right';
}

/**
 * 管脚定义 → 原理图符号。
 * 实现见 custom-symbol.ts（布局规则移植自 ds2kicad，遵循 KLC S4）。
 * 旧实现用 10px 栅格且顶部/左侧管脚坐标为负，而渲染层把 ParsedSymbol 坐标
 * 直接当 SVG 单位用 —— 符号会跑出画框，这是"定制器件没有符号"的根因。
 */
export { buildCustomSymbol } from './custom-symbol';
import { buildCustomSymbol as buildSym } from './custom-symbol';

/** 定制封装：焊盘阵列（按合成名解析）+ 独立模块轮廓 + 焊盘偏移
 *  焊盘可能只占模块的一部分（如带屏蔽罩的模组），故轮廓与焊盘范围解耦 */
export function buildCustomFootprint(pkg: CustomPkg, pinCount: number): PadFootprint | null {
  // 手动坐标：焊盘表直接构成封装（THT 圆盘 / SMD 矩形）
  if (pkg.family === 'manual') {
    const pads = (pkg.manualPads ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!pads.length) return null;
    const ext = (sel: (p: ManualPad) => number, half: (p: ManualPad) => number) => Math.max(...pads.map((p) => Math.abs(sel(p)) + half(p)));
    return {
      // 本体尺寸优先级：自定义轮廓 > 向导填的本体尺寸 > 由焊盘范围反推。
      // 手动焊盘模式此前只认 outlineW/H，忽略了用户填的 bodyW/H —— 3D 模型会按
      // 焊盘范围缩水（如模组只有边缘两个焊盘时，本体被算成一条窄条）。
      bodyW: pkg.outlineW && pkg.outlineW > 0 ? pkg.outlineW
        : pkg.bodyW > 0 ? pkg.bodyW
        : ext((p) => p.x, (p) => p.w / 2) * 2 + 1,
      bodyH: pkg.outlineH && pkg.outlineH > 0 ? pkg.outlineH
        : pkg.bodyH > 0 ? pkg.bodyH
        : ext((p) => p.y, (p) => p.h / 2) * 2 + 1,
      pads: pads.map((p, i) => ({ num: Number.isFinite(parseInt(p.num, 10)) ? parseInt(p.num, 10) : i + 1, x: p.x + (pkg.padsOffsetX ?? 0), y: p.y + (pkg.padsOffsetY ?? 0), w: p.w, h: p.h, round: p.round })),
      pin1: { x: pads[0].x + (pkg.padsOffsetX ?? 0), y: pads[0].y + (pkg.padsOffsetY ?? 0) },
    };
  }
  const base = padFootprintFor(synthFootprintName(pkg, pinCount));
  if (!base) return null;
  const dx = pkg.padsOffsetX ?? 0;
  const dy = pkg.padsOffsetY ?? 0;
  const outW = pkg.outlineW && pkg.outlineW > 0 ? pkg.outlineW : base.bodyW;
  const outH = pkg.outlineH && pkg.outlineH > 0 ? pkg.outlineH : base.bodyH;
  return {
    bodyW: outW,
    bodyH: outH,
    pads: base.pads.map((pd) => ({ ...pd, x: pd.x + dx, y: pd.y + dy })),
    pin1: base.pin1 ? { x: base.pin1.x + dx, y: base.pin1.y + dy } : undefined,
  };
}

/** 定制器件的封装注册名（唯一，避免与库中同名封装冲突） */
export function customFootprintName(part: { mpn: string; pkg: CustomPkg; pins: unknown[] }): string {
  if (part.pkg.family === 'manual') return `CUSTOM_${part.mpn}`;
  const hasOutline = (part.pkg.outlineW ?? 0) > 0 || (part.pkg.padsOffsetX ?? 0) !== 0 || (part.pkg.padsOffsetY ?? 0) !== 0;
  // 无自定义轮廓时直接用标准合成名（可复用库内解析与 3D）
  return hasOutline ? `CUSTOM_${part.mpn}` : synthFootprintName(part.pkg, part.pins.length);
}

export function loadCustomParts(): CustomPart[] {
  try {
    return JSON.parse(store.get(LS_KEY) ?? '[]') as CustomPart[];
  } catch {
    return [];
  }
}

function registerPart(part: CustomPart) {
  const sym = buildSym(part.pins);
  if (sym) registerSymbolOverride(part.mpn, sym);
  const fp = buildCustomFootprint(part.pkg, part.pins.length);
  if (fp) registerFootprintOverride(part.footprintName, fp);
}

export function saveCustomPart(part: CustomPart) {
  const list = loadCustomParts().filter((p) => p.id !== part.id);
  list.unshift(part);
  store.set(LS_KEY, JSON.stringify(list.slice(0, 100)));
  registerPart(part);
}

export function deleteCustomPart(id: string) {
  store.set(LS_KEY, JSON.stringify(loadCustomParts().filter((p) => p.id !== id)));
}

/** 启动时注册所有定制符号覆盖 */
export function bootCustomLib() {
  for (const p of loadCustomParts()) registerPart(p);
}

/** 转搜索结果对象 → addComponent 直接上画布 */
export function customPartToResult(p: CustomPart): ComponentSearchResult {
  return {
    componentId: `custom_${p.id}`,
    mpn: p.mpn,
    manufacturer: '自建',
    category: p.category,
    defaultFootprintName: p.footprintName,
    family: 'Custom',
    description: p.description ?? '定制器件',
    pins: p.pins.length,
  } as ComponentSearchResult;
}

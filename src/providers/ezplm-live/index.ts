/**
 * providers/ezplm-live/index.ts
 * ezPLM 实时数据 Provider —— 经 /api/ezplm 签名代理调用真实接口。
 *
 * 官方接口仅两个只读端点：
 *   GET parts?keyword=              系统库物料（白名单供应商）
 *   GET reference-designs?partlibId= 参考设计
 *
 * 手册确认的字段：id / mpn / manufacturer / footprint / symbol / pdf / attributes，
 * 但未给出 footprint/pdf/attributes 的精确结构 —— 本文件的映射按【防御式】编写，
 * 兼容 字符串 / {name|url} 对象 / 数组 多种形态。首次真实调用后如需微调，只改本文件。
 */
import type { ComponentSearchResult } from '../types';
import type { ComponentCategory } from '../../design-core/document/types';
import { padFootprintFor } from '../../design-core/geometry/footprint-pads';

const EZ_PREFIX = 'ez_';

/* ---------- 可用性探测（status 不消耗上游配额，结果缓存） ---------- */
let availableCache: boolean | null = null;

export async function ezplmLiveAvailable(): Promise<boolean> {
  if (availableCache !== null) return availableCache;
  try {
    const r = await fetch('/api/ezplm?path=status');
    const j = await r.json();
    availableCache = !!j.configured;
  } catch {
    availableCache = false; // 本地 vite dev 无 serverless 函数时走这里
  }
  return availableCache;
}

/* ---------- 防御式取值工具 ---------- */
type Raw = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/** footprint 字段：string | {name|footprint|value} | [first] */
function pickName(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v);
  if (Array.isArray(v)) return pickName(v[0]);
  if (v && typeof v === 'object') {
    const o = v as Raw;
    return str(o.name) ?? str(o.footprint) ?? str(o.value) ?? str(o.title);
  }
  return undefined;
}

/** pdf/symbol 等文件字段：string(url) | {url|link|file|path} */
function pickUrl(v: unknown): string | undefined {
  if (typeof v === 'string') return /^https?:\/\//.test(v) ? v : undefined;
  if (Array.isArray(v)) return pickUrl(v[0]);
  if (v && typeof v === 'object') {
    const o = v as Raw;
    return pickUrl(o.url) ?? pickUrl(o.link) ?? pickUrl(o.file) ?? pickUrl(o.path) ?? pickUrl(o.href);
  }
  return undefined;
}

/** 库文件链接：绝对 URL，或站内相对路径（自动补 https://www.ezplm.cn 前缀） */
function pickFileUrl(v: unknown): string | undefined {
  const abs = pickUrl(v);
  if (abs) return abs;
  const rel = (x: unknown): string | undefined => {
    if (typeof x === 'string' && x.startsWith('/') && x.length > 1) return `https://www.ezplm.cn${x}`;
    if (Array.isArray(x)) return rel(x[0]);
    if (x && typeof x === 'object') {
      const o = x as Raw;
      return rel(o.url) ?? rel(o.link) ?? rel(o.file) ?? rel(o.path) ?? rel(o.href) ?? rel(o.download) ?? rel(o.fileUrl);
    }
    return undefined;
  };
  return rel(v);
}

/** attributes：对象 | [{name|key|label, value}] → 扁平键值对（取前 10 项） */
function pickAttrs(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === 'object') {
        const o = item as Raw;
        const k = str(o.name) ?? str(o.key) ?? str(o.label);
        const val = str(o.value) ?? (typeof o.value === 'number' ? String(o.value) : undefined);
        if (k && val) out[k] = val;
      }
      if (Object.keys(out).length >= 10) break;
    }
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Raw)) {
      const sv = typeof val === 'string' ? val : typeof val === 'number' ? String(val) : undefined;
      if (sv) out[k] = sv;
      if (Object.keys(out).length >= 10) break;
    }
  }
  return out;
}

/** 类别推断：手册未提供 category 字段，按型号/描述/参数关键词判断 */
function inferCategory(text: string): ComponentCategory {
  const t = text.toUpperCase();
  if (/(继电器|RELAY|蜂鸣|BUZZER|开关|SWITCH|按键|BUTTON|TACTILE)/.test(t)) return 'electromech';
  if (/(传感|SENSOR|温湿度|加速度|陀螺|气压|光敏)/.test(t)) return 'sensor';
  if (/(射频|无线|WIFI|BLE|蓝牙|LORA|天线|ANTENNA|2\.4G)/.test(t)) return 'rf';
  if (/(STM32|GD32|ESP32|CH32|APM32|RP2\d{3}|MCU|单片机|微控制)/.test(t)) return 'mcu';
  if (/(LDO|DC-?DC|BUCK|BOOST|稳压|电源管理|REGULATOR|TPS\d|MP\d{4}|AMS1117|LM1117)/.test(t)) return 'power';
  if (/(连接器|CONNECTOR|USB|排针|HEADER|TYPE-?C|插座)/.test(t)) return 'connector';
  if (/(电容|电阻|电感|CAPACITOR|RESISTOR|INDUCTOR|MLCC|^RC\d{4}|^CL\d{2})/.test(t)) return 'passive';
  return 'ic';
}

let loggedSample = false;

/** 单个物料映射 */
export function mapEzplmPart(raw: Raw): ComponentSearchResult {
  if (!loggedSample) {
    loggedSample = true;
    // 诊断辅助：浏览器控制台可查看真实字段结构，用于校准映射
    console.info('[ezPLM] 首条物料原始字段样例:', raw);
    console.info('[ezPLM] footprint 字段原始值:', raw.footprint, '| symbol 字段原始值:', raw.symbol);
  }
  const id = str(raw.id) ?? str(raw.partlibId) ?? String(Math.random()).slice(2);
  const mpn = str(raw.mpn) ?? str(raw.model) ?? str(raw.partNumber) ?? str(raw.name) ?? id;
  // 厂商字段防御式提取：兼容字符串 / {name} 对象 / 多种字段名
  const manufacturer = pickName(raw.manufacturer) ?? pickName(raw.vendor) ?? pickName(raw.brand)
    ?? pickName((raw as Record<string, unknown>).mfr) ?? pickName((raw as Record<string, unknown>).manufacturerName)
    ?? pickName((raw as Record<string, unknown>)['厂商']) ?? '—';
  const fpRaw = pickName(raw.footprint);
  // 保留原始 KiCad 封装名 —— 优先运行时解析真实 .kicad_mod 文件（下方 URL），
  // 文件拉取中/失败时回退名字参数化解析；名字也缺失时回退内置默认
  const footprint = fpRaw ?? 'SOIC-8';
  // 库文件链接（防御式：footprint/symbol 字段可能是 {name,url} 对象，或独立字段）
  const R = raw as Record<string, unknown>;
  // 真实字段结构（已确认）：footprint.kicadModFile.url / footprint.stepFile.url / symbol.kicadSymFile.url
  const fpObj = raw.footprint && typeof raw.footprint === 'object' ? (raw.footprint as Raw) : undefined;
  const symObj = raw.symbol && typeof raw.symbol === 'object' ? (raw.symbol as Raw) : undefined;
  const footprintFileUrl = pickFileUrl(fpObj?.kicadModFile) ?? pickFileUrl(raw.footprint) ?? pickFileUrl(R.footprintFile) ?? pickFileUrl(R.footprintUrl);
  const symbolFileUrl = pickFileUrl(symObj?.kicadSymFile) ?? pickFileUrl(raw.symbol) ?? pickFileUrl(R.symbolFile) ?? pickFileUrl(R.symbolUrl);
  // 分类（接口返回的原始分类文本，直接展示；并优先用于类别归类）
  const classification = pickName(raw.category) ?? pickName((raw as Record<string, unknown>).classification)
    ?? pickName((raw as Record<string, unknown>).catalog) ?? pickName((raw as Record<string, unknown>)['分类']);
  const attrs = pickAttrs(raw.attributes);
  const description = str(raw.description) ?? str(raw.productName) ?? str(raw.title) ?? Object.entries(attrs).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
  const category = inferCategory([classification ?? '', mpn, manufacturer, description, fpRaw ?? '', Object.values(attrs).join(' ')].join(' '));
  return {
    componentId: EZ_PREFIX + id,
    mpn,
    manufacturer,
    category,
    defaultFootprintName: footprint,
    family: str(raw.family) ?? 'ezPLM',
    description: description || `${manufacturer} ${mpn}`,
    pins: typeof raw.pins === 'number' ? raw.pins : padFootprintFor(footprint)?.pads.length ?? 8,
    attributes: attrs,
    coreParams: attrs,
    datasheetUrl: pickUrl(raw.pdf) ?? pickUrl(raw.datasheet),
    productUrl: pickUrl(raw.officialUrl) ?? pickUrl(R.official_url),
    // 手册的 parts 响应未定义 3D 模型字段；此处防御式探测常见命名，命中则启用 STEP 下载
    stepUrl: pickFileUrl(fpObj?.stepFile) ?? pickFileUrl(raw.step) ?? pickFileUrl(raw.model3d) ?? pickFileUrl(raw.stepFile),
    footprintFileUrl,
    symbolFileUrl,
    classification,
    imageUrl: pickFileUrl(raw.image) ?? pickFileUrl(raw.photo) ?? pickFileUrl(R.picture) ?? pickFileUrl(R.img)
      ?? pickFileUrl(R.thumbnail) ?? pickFileUrl(R.imageUrl) ?? pickFileUrl(R.productImage),
  };
}

/* ---------- 接口调用 ---------- */

export async function searchEzplmParts(keyword: string, pageSize = 20): Promise<{ available: boolean; items: ComponentSearchResult[] }> {
  if (!(await ezplmLiveAvailable())) return { available: false, items: [] };
  try {
    const r = await fetch(`/api/ezplm?path=parts&keyword=${encodeURIComponent(keyword)}&pageSize=${pageSize}`);
    if (!r.ok) return { available: r.status !== 501, items: [] };
    const j = await r.json();
    const list: Raw[] = Array.isArray(j?.data) ? j.data : [];
    return { available: true, items: list.map(mapEzplmPart) };
  } catch {
    return { available: false, items: [] };
  }
}

export interface ReferenceDesign { name: string; link?: string; image?: string; description?: string; }

export async function getEzplmReferenceDesigns(componentId: string, pageSize = 10): Promise<ReferenceDesign[]> {
  if (!componentId.startsWith(EZ_PREFIX)) return [];
  if (!(await ezplmLiveAvailable())) return [];
  const partlibId = componentId.slice(EZ_PREFIX.length);
  try {
    const r = await fetch(`/api/ezplm?path=reference-designs&partlibId=${encodeURIComponent(partlibId)}&pageSize=${pageSize}`);
    if (!r.ok) return [];
    const j = await r.json();
    const list: Raw[] = Array.isArray(j?.data) ? j.data : [];
    return list.map((d) => ({
      name: str(d.name) ?? '参考设计',
      link: pickUrl(d.link) ?? pickUrl(d.url),
      image: pickUrl(d.image),
      description: str(d.description),
    }));
  } catch {
    return [];
  }
}

export function isEzplmPart(componentId: string): boolean {
  return componentId.startsWith(EZ_PREFIX);
}

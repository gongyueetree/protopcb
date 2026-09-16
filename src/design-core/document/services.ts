/**
 * design-core/document/services.ts
 * 文档级业务服务：搜索结果→放置器件、BOM 生成、设计审查。
 * 纯函数，输入文档/数据，输出新数据。
 */
import { nanoid } from 'nanoid';
import type {
  ComponentSource,
  CircuitCanvasDocument, PlacedComponent, BomLine, ReviewFinding, ComponentCategory,
} from './types';
import type { PartCandidate } from './candidate';
import { fallbackFootprintGeometry as geometryFor } from '../geometry/fallback-geometry';
import { padFootprintFor } from '../geometry/footprint-pads';
import { findOverlaps } from '../collision';
import { classifyPart } from '../semantics/part';

/** 类别兜底前缀（KiCad 习惯） */
const REF_PREFIX: Record<ComponentCategory, string> = { mcu: 'U', power: 'U', passive: 'R', connector: 'J', ic: 'U', electromech: 'SW', sensor: 'U', rf: 'U' };

/** 位号前缀：委托统一的 PartSemanticClassifier（型号/封装/描述优先，抽象类别兜底） */
export function refPrefixFor(r: { category: ComponentCategory; mpn?: string; defaultFootprintName?: string; description?: string }): string {
  const sem = classifyPart({ mpn: r.mpn, footprint: r.defaultFootprintName, description: r.description, category: r.category });
  // 抽象类别兜底时沿用原表（passive→R、electromech→SW 等）
  return sem.evidence === 'category' || sem.evidence === 'none' ? (REF_PREFIX[r.category] ?? 'U') : sem.defaultRefPrefix;
}

/** 为器件生成下一个位号（前缀按 KiCad 习惯：R/C/L/D/Q/U/J/Y/SW…）。 */
export function nextReference(r: { category: ComponentCategory; mpn?: string; defaultFootprintName?: string; description?: string } | ComponentCategory, existing: PlacedComponent[]): string {
  const prefix = typeof r === 'string' ? (REF_PREFIX[r] ?? 'U') : refPrefixFor(r);
  // 精确前缀匹配（避免 SW 与 S、C 与 CP 相互干扰）
  const rx = new RegExp(`^${prefix}(\\d+)$`);
  const used = existing.map((c) => c.reference.match(rx)?.[1]).filter((v): v is string => !!v).map((v) => parseInt(v, 10));
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}${n}`;
}

/** 搜索结果 → 已放置器件（位置暂置 0，由放置引擎求解）。 */
/** 依据器件来源判定可信等级（数据事实 vs 模型猜测） */
/**
 * 由候选**显式携带的 source** 推断来源；缺失时才按 componentId 前缀做 legacy 推断。
 * 生产数据不得因为"不属于 ezPLM"就被写成 MOCK —— MOCK 只给演示数据。
 */
export function sourceForCandidate(r: PartCandidate): ComponentSource {
  if (r.source) return r.source;
  const id = r.componentId ?? '';
  if (r.org) return 'ORGANIZATION';
  if (id.startsWith('ez_')) return 'EZPLM';
  if (id.startsWith('sup_dk_') || id.startsWith('dk_')) return 'DIGIKEY';
  if (id.startsWith('sup_mouser_') || id.startsWith('mouser_')) return 'MOUSER';
  if (id.startsWith('sup_')) return 'SUPPLIER';
  if (id.startsWith('kicadlib_') || id.startsWith('kicad_')) return 'KICAD';
  if (id.startsWith('custom_') || id.startsWith('fp_')) return 'CUSTOM';
  if (id.startsWith('sub_') || id.startsWith('ai_')) return 'AI';
  if (id.startsWith('mock_')) return 'MOCK';
  // 来源不明：是"未知来源的真实候选"，不是演示数据
  return 'IMPORTED_PROJECT';
}

function trustForResult(r: PartCandidate): PlacedComponent['trust'] {
  const id = r.componentId ?? '';
  const now = new Date().toISOString();
  const src = sourceForCandidate(r);
  // 显式 source 优先于前缀推断
  if (src === 'EZPLM' || src === 'ORGANIZATION') {
    return { level: 'VERIFIED', evidence: 'ezPLM 库内器件', verifiedAt: now, source: 'ezPLM' };
  }
  if (src === 'DIGIKEY' || src === 'MOUSER' || src === 'SUPPLIER') {
    return { level: 'VERIFIED', evidence: '分销商 API 精确匹配', verifiedAt: now, source: '分销商' };
  }
  if (src === 'KICAD') return { level: 'CANDIDATE', evidence: 'KiCad 官方封装，型号需自行指定', source: 'KiCad 库' };
  if (src === 'AI') return { level: 'PLACEHOLDER', evidence: 'AI 建议的通用件，未经数据库验证', source: 'AI' };
  if (src === 'CUSTOM') return { level: 'CANDIDATE', evidence: '自建器件，参数由用户提供', source: '自建' };
  if (id.startsWith('ez_') || r.org) {
    return { level: 'VERIFIED', evidence: 'ezPLM 库内器件', verifiedAt: now, source: 'ezPLM' };
  }
  if (id.startsWith('sup_')) {
    return { level: 'VERIFIED', evidence: '分销商 API 精确匹配', verifiedAt: now, source: '分销商' };
  }
  if (id.startsWith('kicadlib_')) {
    return { level: 'CANDIDATE', evidence: 'KiCad 官方封装，型号需自行指定', source: 'KiCad 库' };
  }
  if (id.startsWith('sub_') || id.startsWith('ai_')) {
    return { level: 'PLACEHOLDER', evidence: 'AI 建议的通用件，未经数据库验证', source: 'AI' };
  }
  if (id.startsWith('custom_') || id.startsWith('fp_')) {
    return { level: 'CANDIDATE', evidence: '自建器件，参数由用户提供', source: '自建' };
  }
  return { level: 'PLACEHOLDER', evidence: '来源未知，需人工核对 datasheet' };
}

export function searchResultToPlaced(r: PartCandidate, reference: string): PlacedComponent {
  const fpName = r.defaultFootprintName;
  // KiCad 名解析命中 → 用真实焊盘范围推导几何（本体 + courtyard），碰撞/避让随之精确
  const fp = padFootprintFor(fpName);
  const geometry = fp ? (() => {
    const exW = Math.max(...fp.pads.map((p) => Math.abs(p.x) + p.w / 2), fp.bodyW / 2) * 2;
    const exH = Math.max(...fp.pads.map((p) => Math.abs(p.y) + p.h / 2), fp.bodyH / 2) * 2;
    return { footprintId: fpName, bodyWidthMm: fp.bodyW, bodyHeightMm: fp.bodyH, courtyardWidthMm: exW + 0.6, courtyardHeightMm: exH + 0.6, padCount: fp.pads.length, rotationStep: 90, anchor: { x: 0, y: 0 } };
  })() : geometryFor(fpName);
  return {
    instanceId: nanoid(10),
    componentId: r.componentId,
    mpn: r.mpn,
    reference,
    category: r.category,
    manufacturer: r.manufacturer,
    footprint: { footprintId: fpName, name: fpName, geometry, confidence: 1 },
    placement: { xMm: 0, yMm: 0, rotation: 0, side: 'TOP', locked: false },
    quantity: 1,
    unitPrice: r.unitPrice,
    source: sourceForCandidate(r),
    // 可信等级：来自 ezPLM/分销商检索的器件是库内命中；
    // 子电路/AI 建议（sub_ 前缀）与占位器件只能算未验证，导出时要显式提示。
    trust: trustForResult(r),
    display: { description: r.description, family: r.family, attributes: r.attributes, pins: r.pins, datasheetUrl: r.datasheetUrl, imageUrl: r.imageUrl, stepUrl: r.stepUrl, officialUrl: r.productUrl, footprintFileUrl: r.footprintFileUrl, symbolFileUrl: r.symbolFileUrl, classification: r.classification },
  };
}

/** 从文档生成 BOM。 */
export function buildBom(doc: CircuitCanvasDocument): BomLine[] {
  // 按 型号+封装 聚合：同型号多实例 → 一行，数量累计，位号串联（R1,R2,R3）
  const lines = new Map<string, BomLine>();
  for (const c of doc.components) {
    const key = `${c.mpn}__${c.footprint.name}`;
    const ex = lines.get(key);
    if (ex) {
      ex.quantity += c.quantity;
      ex.reference = `${ex.reference},${c.reference}`;
    } else {
      lines.set(key, {
        reference: c.reference,
        mpn: c.mpn,
        manufacturer: c.manufacturer,
        footprint: c.footprint.name,
        quantity: c.quantity,
        unitPrice: c.unitPrice,
        description: c.display?.description,
      });
    }
  }
  return [...lines.values()];
}

export function bomTotal(bom: BomLine[]): number {
  return bom.reduce((s, l) => s + (l.unitPrice?.amount ?? 0) * l.quantity, 0);
}

/** 设计审查（实时）。 */
/** 短稳定哈希（仅用于生成可复现的 ID，不用于安全场景） */
function stableHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export function runDesignReview(doc: CircuitCanvasDocument): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const cats = new Set(doc.components.map((c) => c.category));
  const has = (c: ComponentCategory) => cats.has(c);
  const push = (level: ReviewFinding['level'], category: ReviewFinding['category'], title: string, detail?: string) =>
    // 确定性 ID：随机 id 会让"导入→导出"的 JSON 每次都不同，
    // 无法做往返比对，也让版本管理产生无意义的 diff。
    out.push({ id: `review:${category}:${stableHash(title)}`, level, category, title, detail });

  if (doc.components.length === 0) { push('info', 'completeness', '画布为空', '添加器件后开始分析'); return out; }
  if (!has('mcu')) push('high', 'completeness', '缺少主控 MCU/处理器');
  if (!has('power')) push('high', 'completeness', '缺少电源管理器件');
  if (has('mcu') && !has('passive')) push('high', 'completeness', 'MCU 缺少去耦电容网络');
  if (has('connector')) push('mid', 'emc', '对外接口建议增加 ESD 保护');

  const overlaps = findOverlaps(doc.components);
  if (overlaps.size > 0) push('high', 'placement', `存在 ${overlaps.size} 个器件重叠`, '需调整布局');

  const areaCm2 = (doc.board.widthMm * doc.board.heightMm) / 100;
  const density = doc.components.length / (areaCm2 / 10);
  if (density > 3) push('mid', 'placement', `器件密度偏高(${density.toFixed(1)}个/10cm²)`, '建议增大板框或4层板');

  push('mid', 'sourcing', '投产前确认物料生命周期状态');
  return out;
}

/** 推荐 PCB 层数。 */
export function recommendLayers(doc: CircuitCanvasDocument): number {
  const pinTotal = doc.components.reduce((s, c) => s + (c.display?.pins ?? 0), 0);
  return doc.components.length > 15 || pinTotal > 200 ? 4 : 2;
}

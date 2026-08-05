/**
 * design-core/document/services.ts
 * 文档级业务服务：搜索结果→放置器件、BOM 生成、设计审查。
 * 纯函数，输入文档/数据，输出新数据。
 */
import { nanoid } from 'nanoid';
import type {
  CircuitCanvasDocument, PlacedComponent, BomLine, ReviewFinding, ComponentCategory,
} from './types';
import type { ComponentSearchResult } from '../../providers/types';
import { geometryFor } from '../../providers/mock/data';
import { padFootprintFor } from '../geometry/footprint-pads';
import { findOverlaps } from '../collision';

const REF_PREFIX: Record<ComponentCategory, string> = { mcu: 'U', power: 'U', passive: 'C', connector: 'J', ic: 'U' };

/** 为某类别生成下一个位号。 */
export function nextReference(category: ComponentCategory, existing: PlacedComponent[]): string {
  const prefix = REF_PREFIX[category] ?? 'X';
  const used = existing.filter((c) => c.reference.startsWith(prefix)).map((c) => parseInt(c.reference.slice(prefix.length), 10) || 0);
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}${n}`;
}

/** 搜索结果 → 已放置器件（位置暂置 0，由放置引擎求解）。 */
export function searchResultToPlaced(r: ComponentSearchResult, reference: string): PlacedComponent {
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
    source: r.org || r.componentId.startsWith('ez_') ? 'EZPLM' : 'MOCK',
    display: { description: r.description, family: r.family, attributes: r.attributes, pins: r.pins, datasheetUrl: r.datasheetUrl, imageUrl: r.imageUrl, stepUrl: r.stepUrl, footprintFileUrl: r.footprintFileUrl, symbolFileUrl: r.symbolFileUrl, classification: r.classification },
  };
}

/** 从文档生成 BOM。 */
export function buildBom(doc: CircuitCanvasDocument): BomLine[] {
  return doc.components.map((c) => ({
    reference: c.reference,
    mpn: c.mpn,
    manufacturer: c.manufacturer,
    footprint: c.footprint.name,
    quantity: c.quantity,
    unitPrice: c.unitPrice,
    description: c.display?.description,
  }));
}

export function bomTotal(bom: BomLine[]): number {
  return bom.reduce((s, l) => s + (l.unitPrice?.amount ?? 0) * l.quantity, 0);
}

/** 设计审查（实时）。 */
export function runDesignReview(doc: CircuitCanvasDocument): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const cats = new Set(doc.components.map((c) => c.category));
  const has = (c: ComponentCategory) => cats.has(c);
  const push = (level: ReviewFinding['level'], category: ReviewFinding['category'], title: string, detail?: string) =>
    out.push({ id: nanoid(6), level, category, title, detail });

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

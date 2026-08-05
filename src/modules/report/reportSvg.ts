/**
 * modules/report/reportSvg.ts
 * 报告用 SVG 生成 —— 框图与 PCB 布局从文档数据程序化生成（不依赖 DOM）；
 * 原理图从当前 DOM 抓取（打开原理图面板时可用）。
 */
import type { CircuitCanvasDocument } from '../../design-core/document/types';
import { PX_PER_MM } from '../../design-core/geometry';
import { padFootprintFor } from '../../design-core/geometry/footprint-pads';
import { mountingHoleCenters, HOLE_DIAMETER_MM } from '../../design-core/collision';

/** 系统框图 SVG（从 functionalBlocks + connections 生成） */
export function buildBlockDiagramSvg(doc: CircuitCanvasDocument): string {
  const blocks = doc.functionalBlocks;
  if (!blocks.length) return '（尚未生成系统框图，打开「系统框图」面板自动生成后再导出报告）';
  const maxX = Math.max(...blocks.map((b) => b.x + b.w)) + 40;
  const maxY = Math.max(...blocks.map((b) => b.y + b.h)) + 40;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${maxX}" height="${maxY}" viewBox="0 0 ${maxX} ${maxY}" font-family="sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="#fafbfc"/>`);
  parts.push(`<defs><marker id="ra" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1L8 5L0 9z" fill="#64748b"/></marker></defs>`);
  const center = (id: string) => { const b = blocks.find((x) => x.id === id); return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2, b } : null; };
  for (const cn of doc.connections) {
    const f = center(cn.fromId), t = center(cn.toId);
    if (!f || !t) continue;
    // 裁剪到框边缘
    const clip = (c: { x: number; y: number; b: typeof blocks[0] }, tw: { x: number; y: number }) => {
      const dx = tw.x - c.x, dy = tw.y - c.y;
      if (!dx && !dy) return c;
      const sx = dx ? c.b.w / 2 / Math.abs(dx) : Infinity, sy = dy ? c.b.h / 2 / Math.abs(dy) : Infinity;
      const sc = Math.min(sx, sy);
      return { x: c.x + dx * sc, y: c.y + dy * sc };
    };
    const p1 = clip(f, t), p2 = clip(t, f);
    parts.push(`<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#64748b" stroke-width="1.5" marker-end="url(#ra)"/>`);
    if (cn.label) parts.push(`<text x="${(p1.x + p2.x) / 2}" y="${(p1.y + p2.y) / 2 - 4}" text-anchor="middle" font-size="9" font-weight="700" fill="#64748b">${cn.label}</text>`);
  }
  for (const b of blocks) {
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${b.color}" fill-opacity="0.12" stroke="${b.color}" stroke-width="1.8"/>`);
    parts.push(`<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="700" fill="${b.color}">${b.label}</text>`);
    if (b.sublabel) parts.push(`<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 16}" text-anchor="middle" font-size="8" fill="#94a3b8">${b.sublabel}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

/** PCB 布局 SVG（真实焊盘，从文档数据生成） */
export function buildPcbLayoutSvg(doc: CircuitCanvasDocument): string {
  const W = doc.board.widthMm * PX_PER_MM, H = doc.board.heightMm * PX_PER_MM;
  const pad = 20;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W + pad * 2}" height="${H + pad * 2}" viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}" font-family="monospace">`);
  // 板框
  const rx = doc.board.shape === 'rounded' ? 18 : doc.board.shape === 'circle' ? Math.min(W, H) / 2 : 6;
  if (doc.board.shape === 'lshape') {
    const cw = W * 0.45, ch = H * 0.4;
    parts.push(`<path d="M0,0 H${W} V${H - ch} H${W - cw} V${H} H0 Z" fill="#f8fdf9" stroke="#2D5F3F" stroke-width="2"/>`);
  } else if (doc.board.shape === 'circle') {
    parts.push(`<circle cx="${W / 2}" cy="${H / 2}" r="${Math.min(W, H) / 2}" fill="#f8fdf9" stroke="#2D5F3F" stroke-width="2"/>`);
  } else {
    parts.push(`<rect width="${W}" height="${H}" rx="${rx}" fill="#f8fdf9" stroke="#2D5F3F" stroke-width="2"/>`);
  }
  // 定位孔
  for (const c of mountingHoleCenters(doc.board)) {
    parts.push(`<circle cx="${c.x * PX_PER_MM}" cy="${c.y * PX_PER_MM}" r="${(HOLE_DIAMETER_MM / 2) * PX_PER_MM}" fill="#cbd5e1" stroke="#64748b"/>`);
  }
  // 器件（真实焊盘）
  for (const comp of doc.components) {
    const cx = comp.placement.xMm * PX_PER_MM, cy = comp.placement.yMm * PX_PER_MM;
    const rot = comp.placement.rotation;
    const isBottom = comp.placement.side === 'BOTTOM';
    const copper = isBottom ? '#3b82c4' : '#c08a2d';
    const pads = padFootprintFor(comp.footprint.name);
    parts.push(`<g transform="translate(${cx},${cy}) rotate(${rot})${isBottom ? ' scale(-1,1)' : ''}">`);
    if (pads) {
      parts.push(`<rect x="${-pads.bodyW * PX_PER_MM / 2}" y="${-pads.bodyH * PX_PER_MM / 2}" width="${pads.bodyW * PX_PER_MM}" height="${pads.bodyH * PX_PER_MM}" rx="2" fill="none" stroke="#1a6b3c" stroke-width="0.9"/>`);
      for (const p of pads.pads) {
        parts.push(`<rect x="${(p.x - p.w / 2) * PX_PER_MM}" y="${(p.y - p.h / 2) * PX_PER_MM}" width="${p.w * PX_PER_MM}" height="${p.h * PX_PER_MM}" rx="${p.round ? (p.w * PX_PER_MM) / 2 : 0.8}" fill="${copper}"/>`);
      }
      if (pads.pin1) parts.push(`<circle cx="${pads.pin1.x * PX_PER_MM}" cy="${pads.pin1.y * PX_PER_MM}" r="1.6" fill="#dc2626"/>`);
    }
    parts.push(`<g transform="${isBottom ? 'scale(-1,1) ' : ''}rotate(${-rot})"><text y="-4" text-anchor="middle" font-size="8" font-weight="700" fill="${isBottom ? '#3b82c4' : '#1a6b3c'}">${comp.reference}</text></g>`);
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('');
}

/** 原理图 SVG —— 从当前 DOM 抓取（需已打开原理图面板） */
export function buildSchematicSvgFromDom(): string | null {
  const svgs = Array.from(document.querySelectorAll('svg'));
  const sch = svgs.find((sv) => sv.querySelector('#schg'));
  if (!sch) return null;
  const clone = sch.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', '900');
  clone.setAttribute('height', '500');
  return clone.outerHTML;
}

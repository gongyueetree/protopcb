/**
 * modules/bom/bom-csv.ts
 * BOM CSV 导出 —— 从导出中心直接调用，不必先切到 BOM 页。
 * 不含价格：价格依赖实时查询与人工确认，导出时现拉会给出一份"看起来权威"的过期报价。
 */
import { buildBom } from '../../design-core/document/services';
import type { CircuitCanvasDocument } from '../../design-core/document/types';

const field = (v: unknown): string => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function bomCsvText(doc: CircuitCanvasDocument): string {
  const header = ['序号', '位号', '型号', '厂商', '封装', '数量', '说明'].join(',');
  const rows = buildBom(doc).map((l, i) => [
    i + 1, l.reference, l.mpn, l.manufacturer ?? '', l.footprint ?? '', l.quantity, l.description ?? '',
  ].map(field).join(','));
  // BOM 常用 Excel 打开，加 BOM 头避免中文乱码
  return '\uFEFF' + [header, ...rows].join('\r\n');
}

export function exportBomCsv(doc: CircuitCanvasDocument): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bomCsvText(doc)], { type: 'text/csv;charset=utf-8' }));
  a.download = `${doc.name || 'design'}-BOM.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

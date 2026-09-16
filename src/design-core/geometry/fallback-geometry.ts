/**
 * design-core/geometry/fallback-geometry.ts
 * 通用封装的兜底几何（本体/外沿/焊盘数）。
 *
 * 这不是演示数据：任何来源的器件在拿不到精确焊盘表时都用它估算占位。
 * 之前放在 providers/mock/data.ts，导致 Domain 反向依赖 Mock —— 现在归 Domain 所有。
 */
import type { FootprintGeometry } from './types';

export const FALLBACK_FOOTPRINT_GEOMETRY: Record<string, FootprintGeometry> = {
  '0402': { footprintId: '0402', bodyWidthMm: 1.0, bodyHeightMm: 0.5, courtyardWidthMm: 1.5, courtyardHeightMm: 0.9, padCount: 2, rotationStep: 90, anchor: { x: 0, y: 0 } },
  '0603': { footprintId: '0603', bodyWidthMm: 1.6, bodyHeightMm: 0.8, courtyardWidthMm: 2.2, courtyardHeightMm: 1.3, padCount: 2, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'SOT-223': { footprintId: 'SOT-223', bodyWidthMm: 6.5, bodyHeightMm: 3.5, courtyardWidthMm: 8.0, courtyardHeightMm: 4.5, assemblyHeightMm: 1.8, padCount: 4, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'SOIC-8': { footprintId: 'SOIC-8', bodyWidthMm: 4.9, bodyHeightMm: 3.9, courtyardWidthMm: 6.0, courtyardHeightMm: 5.0, assemblyHeightMm: 1.75, padCount: 8, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'SOP-16': { footprintId: 'SOP-16', bodyWidthMm: 10.0, bodyHeightMm: 4.0, courtyardWidthMm: 11.0, courtyardHeightMm: 6.4, padCount: 16, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'LQFP-48': { footprintId: 'LQFP-48', bodyWidthMm: 7.0, bodyHeightMm: 7.0, courtyardWidthMm: 9.2, courtyardHeightMm: 9.2, assemblyHeightMm: 1.6, padCount: 48, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'LQFP-100': { footprintId: 'LQFP-100', bodyWidthMm: 14.0, bodyHeightMm: 14.0, courtyardWidthMm: 16.2, courtyardHeightMm: 16.2, assemblyHeightMm: 1.6, padCount: 100, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'Module-44': { footprintId: 'Module-44', bodyWidthMm: 18.0, bodyHeightMm: 25.5, courtyardWidthMm: 19.0, courtyardHeightMm: 26.5, assemblyHeightMm: 3.1, padCount: 44, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'USB-C-16P': { footprintId: 'USB-C-16P', bodyWidthMm: 9.0, bodyHeightMm: 7.3, courtyardWidthMm: 10.5, courtyardHeightMm: 8.5, assemblyHeightMm: 3.2, padCount: 16, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'THT-2.54mm': { footprintId: 'THT-2.54mm', bodyWidthMm: 5.08, bodyHeightMm: 12.7, courtyardWidthMm: 6.0, courtyardHeightMm: 13.7, padCount: 10, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'TSOT-23-8': { footprintId: 'TSOT-23-8', bodyWidthMm: 2.9, bodyHeightMm: 2.8, courtyardWidthMm: 4.2, courtyardHeightMm: 3.6, padCount: 8, rotationStep: 90, anchor: { x: 0, y: 0 } },
  '4018': { footprintId: '4018', bodyWidthMm: 4.0, bodyHeightMm: 4.0, courtyardWidthMm: 4.6, courtyardHeightMm: 4.6, assemblyHeightMm: 2.1, padCount: 2, rotationStep: 90, anchor: { x: 0, y: 0 } },
};

/** 未知封装名回落到 SOIC-8 尺寸（比"0"尺寸更接近真实器件） */
export function fallbackFootprintGeometry(name: string): FootprintGeometry {
  return FALLBACK_FOOTPRINT_GEOMETRY[name] ?? FALLBACK_FOOTPRINT_GEOMETRY['SOIC-8'];
}

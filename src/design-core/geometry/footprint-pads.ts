/**
 * design-core/geometry/footprint-pads.ts
 * 真实焊盘几何数据 —— 取自 KiCad 标准封装库的实际尺寸（mm）。
 *
 * 每个封装包含：焊盘列表(位置+尺寸)、本体丝印外框、引脚1标记。
 * 坐标原点 = 封装中心，单位 mm，与 design-core/geometry 一致。
 *
 * 数据来源参考 KiCad footprint libraries (Package_SO, Package_QFP,
 * Package_TO_SOT_SMD, Resistor_SMD, Connector_USB 等)。
 * 正式版可由 EzplmComponentDataProvider 返回真实焊盘，结构相同。
 */

import { parseKicadFootprintName } from './kicad-name-parser';
import { footprintOverrideFor } from './lib-file-registry';

export interface Pad {
  /** 焊盘中心相对封装中心 (mm) */
  x: number;
  y: number;
  /** 焊盘尺寸 (mm) */
  w: number;
  h: number;
  /** 引脚号（用于显示/调试） */
  num: number;
  /** 圆形焊盘（THT）时为 true */
  round?: boolean;
}

export interface PadFootprint {
  /** 本体丝印外框 (mm) */
  bodyW: number;
  bodyH: number;
  pads: Pad[];
  /** 引脚1标记位置 (mm)，可选 */
  pin1?: { x: number; y: number };
}

/** 生成双列(SOIC/SOP/QFP 边)焊盘 */
function dualRow(count: number, pitch: number, rowGap: number, padW: number, padH: number, startNum = 1): Pad[] {
  const pads: Pad[] = [];
  const per = count / 2;
  const y0 = -((per - 1) * pitch) / 2;
  // 左列：从上到下
  for (let i = 0; i < per; i++) pads.push({ x: -rowGap / 2, y: y0 + i * pitch, w: padW, h: padH, num: startNum + i });
  // 右列：从下到上
  for (let i = 0; i < per; i++) pads.push({ x: rowGap / 2, y: y0 + (per - 1 - i) * pitch, w: padW, h: padH, num: startNum + per + i });
  return pads;
}

/** 生成四边 QFP 焊盘 */
function quad(perSide: number, pitch: number, bodyEdge: number, padLen: number, padW: number): Pad[] {
  const pads: Pad[] = [];
  const start = -((perSide - 1) * pitch) / 2;
  const off = bodyEdge / 2 + padLen / 2 - 0.2;
  let n = 1;
  // 左
  for (let i = 0; i < perSide; i++) pads.push({ x: -off, y: start + i * pitch, w: padLen, h: padW, num: n++ });
  // 下
  for (let i = 0; i < perSide; i++) pads.push({ x: start + i * pitch, y: off, w: padW, h: padLen, num: n++ });
  // 右
  for (let i = 0; i < perSide; i++) pads.push({ x: off, y: start + (perSide - 1 - i) * pitch, w: padLen, h: padW, num: n++ });
  // 上
  for (let i = 0; i < perSide; i++) pads.push({ x: start + (perSide - 1 - i) * pitch, y: -off, w: padW, h: padLen, num: n++ });
  return pads;
}

export const PAD_FOOTPRINTS: Record<string, PadFootprint> = {
  // 贴片阻容
  '0402': { bodyW: 1.0, bodyH: 0.5, pads: [{ x: -0.51, y: 0, w: 0.56, h: 0.62, num: 1 }, { x: 0.51, y: 0, w: 0.56, h: 0.62, num: 2 }] },
  '0603': { bodyW: 1.6, bodyH: 0.8, pads: [{ x: -0.79, y: 0, w: 0.8, h: 0.95, num: 1 }, { x: 0.79, y: 0, w: 0.8, h: 0.95, num: 2 }] },
  '0805': { bodyW: 2.0, bodyH: 1.25, pads: [{ x: -0.95, y: 0, w: 1.0, h: 1.45, num: 1 }, { x: 0.95, y: 0, w: 1.0, h: 1.45, num: 2 }] },
  '4018': { bodyW: 4.0, bodyH: 4.0, pads: [{ x: -1.5, y: 0, w: 1.6, h: 3.8, num: 1 }, { x: 1.5, y: 0, w: 1.6, h: 3.8, num: 2 }], pin1: { x: -1.5, y: -1.8 } },

  // SOT
  'SOT-223': {
    bodyW: 6.5, bodyH: 3.5,
    pads: [
      { x: -2.3, y: 1.6, w: 2.0, h: 1.5, num: 1 },
      { x: 0, y: 1.6, w: 2.0, h: 1.5, num: 2 },
      { x: 2.3, y: 1.6, w: 2.0, h: 1.5, num: 3 },
      { x: 0, y: -1.6, w: 3.8, h: 2.0, num: 4 },
    ],
    pin1: { x: -2.3, y: 1.6 },
  },
  'TSOT-23-8': { bodyW: 2.9, bodyH: 2.8, pads: dualRow(8, 0.65, 2.8, 0.4, 0.9), pin1: { x: -1.4, y: -0.975 } },

  // SOIC / SOP
  'SOIC-8': { bodyW: 4.9, bodyH: 3.9, pads: dualRow(8, 1.27, 5.4, 1.5, 0.6), pin1: { x: -2.7, y: -1.905 } },
  'SOP-16': { bodyW: 10.0, bodyH: 4.0, pads: dualRow(16, 1.27, 5.4, 1.5, 0.6), pin1: { x: -2.7, y: -4.445 } },

  // QFP
  'LQFP-48': { bodyW: 7.0, bodyH: 7.0, pads: quad(12, 0.5, 7.0, 1.5, 0.3), pin1: { x: -2.75, y: -3.4 } },
  'LQFP-100': { bodyW: 14.0, bodyH: 14.0, pads: quad(25, 0.5, 14.0, 1.5, 0.3), pin1: { x: -5.75, y: -6.9 } },

  // 模组
  'Module-44': {
    bodyW: 18.0, bodyH: 25.5,
    pads: (() => {
      const p: Pad[] = [];
      // 简化：三边 SMD 焊盘
      for (let i = 0; i < 15; i++) { p.push({ x: -8.5, y: -11 + i * 1.5, w: 1.5, h: 0.9, num: i + 1 }); p.push({ x: 8.5, y: -11 + i * 1.5, w: 1.5, h: 0.9, num: i + 16 }); }
      for (let i = 0; i < 13; i++) p.push({ x: -7.5 + i * 1.25, y: 12.5, w: 0.9, h: 1.5, num: i + 31 });
      return p;
    })(),
    pin1: { x: -8.5, y: -11 },
  },

  // 连接器
  'USB-C-16P': {
    bodyW: 9.0, bodyH: 7.3,
    pads: (() => {
      const p: Pad[] = [];
      for (let i = 0; i < 12; i++) p.push({ x: -3.2 + i * 0.5, y: 2.5, w: 0.3, h: 1.0, num: i + 1 });
      // 固定脚
      p.push({ x: -4.3, y: -2.5, w: 1.2, h: 1.8, num: 13 });
      p.push({ x: 4.3, y: -2.5, w: 1.2, h: 1.8, num: 14 });
      return p;
    })(),
    pin1: { x: -3.2, y: 2.5 },
  },
  'THT-2.54mm': {
    bodyW: 5.08, bodyH: 12.7,
    pads: (() => {
      const p: Pad[] = [];
      for (let r = 0; r < 5; r++) { p.push({ x: -1.27, y: -5.08 + r * 2.54, w: 1.7, h: 1.7, num: r * 2 + 1, round: true }); p.push({ x: 1.27, y: -5.08 + r * 2.54, w: 1.7, h: 1.7, num: r * 2 + 2, round: true }); }
      return p;
    })(),
    pin1: { x: -1.27, y: -5.08 },
  },
};

const parsedCache = new Map<string, PadFootprint | null>();

export function padFootprintFor(name: string): PadFootprint | null {
  // 运行时解析的真实 .kicad_mod 覆盖优先（逐点精确）
  const override = footprintOverrideFor(name);
  if (override) return override;
  const builtin = PAD_FOOTPRINTS[name];
  if (builtin) return builtin;
  // ezPLM 返回的标准 KiCad 封装名 → 参数化解析真实焊盘
  if (!parsedCache.has(name)) parsedCache.set(name, parseKicadFootprintName(name));
  return parsedCache.get(name) ?? null;
}

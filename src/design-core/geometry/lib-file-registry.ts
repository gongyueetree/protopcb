/**
 * design-core/geometry/lib-file-registry.ts
 * 库文件注册表 —— 运行时按需拉取 ezPLM 的 .kicad_mod / .kicad_sym 文件，
 * 解析后注册为「精确覆盖」：padFootprintFor / symbolFor 优先取覆盖数据；
 * version 递增驱动画布/3D/详情等订阅方重渲染。拉取中或失败自动回退名字解析。
 */
import { create } from 'zustand';
import type { PadFootprint } from './footprint-pads';
import { parseKicadMod, parseSExpr, type SExpr } from './kicad-file-parser';

/* ---------- 覆盖存储（模块级，同步读取） ---------- */
const footprintOverrides = new Map<string, PadFootprint>(); // key: 封装名
export interface ParsedSymbol {
  w: number; h: number;
  rects: { x: number; y: number; w: number; h: number }[];
  pins: { tipX: number; tipY: number; endX: number; endY: number; name: string; number: string; nameX: number; nameY: number; numX: number; numY: number }[];
}
const symbolOverrides = new Map<string, ParsedSymbol>(); // key: mpn

export function footprintOverrideFor(name: string): PadFootprint | undefined {
  return footprintOverrides.get(name);
}
export function symbolOverrideFor(mpn: string): ParsedSymbol | undefined {
  return symbolOverrides.get(mpn);
}

/* ---------- 拉取状态与版本 ---------- */
interface LibFileState {
  version: number;
  bump: () => void;
}
export const useLibFileStore = create<LibFileState>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));

const inflight = new Set<string>();
const failed = new Set<string>();

async function fetchViaProxy(url: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/ezplm?path=file&url=${encodeURIComponent(url)}`);
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/** 按需拉取并注册封装文件（幂等；重复调用无副作用） */
export function ensureFootprintFile(fpName: string, url: string | undefined) {
  if (!url || footprintOverrides.has(fpName) || inflight.has(url) || failed.has(url)) return;
  inflight.add(url);
  fetchViaProxy(url).then((text) => {
    inflight.delete(url);
    const parsed = text ? parseKicadMod(text) : null;
    if (parsed) {
      footprintOverrides.set(fpName, parsed);
      useLibFileStore.getState().bump();
    } else {
      failed.add(url);
      console.warn('[libfile] 封装文件解析失败，回退名字解析:', fpName, url);
    }
  });
}

/* ---------- .kicad_sym 解析 ---------- */

const isList = (e: SExpr): e is SExpr[] => Array.isArray(e);
const head = (e: SExpr): string => (isList(e) ? String(e[0]) : String(e));
const find = (l: SExpr[], t: string) => l.find((e): e is SExpr[] => isList(e) && head(e) === t);
const findAll = (l: SExpr[], t: string) => l.filter((e): e is SExpr[] => isList(e) && head(e) === t);
const num = (l: SExpr[] | undefined, i: number) => (l ? parseFloat(String(l[i])) || 0 : 0);

/** KiCad 符号 mm(Y上) → 画布 px(Y下)，2.54mm 引脚栅格 ↔ 10px 栅格 */
const S = 10 / 2.54;

export function parseKicadSym(text: string): ParsedSymbol | null {
  try {
    const roots = parseSExpr(text);
    const lib = roots.find((r): r is SExpr[] => isList(r) && head(r) === 'kicad_symbol_lib');
    const symRoot = lib ? find(lib, 'symbol') : roots.find((r): r is SExpr[] => isList(r) && head(r) === 'symbol');
    if (!symRoot) return null;
    // 收集所有嵌套子 symbol（_0_1 图形单元 / _1_1 引脚单元）里的 rectangle 与 pin
    const rects: SExpr[][] = [];
    const pins: SExpr[][] = [];
    const walk = (node: SExpr[]) => {
      rects.push(...findAll(node, 'rectangle'));
      pins.push(...findAll(node, 'pin'));
      for (const sub of findAll(node, 'symbol')) walk(sub);
    };
    walk(symRoot);
    if (!pins.length) return null;

    // 世界范围（mm，Y上）：引脚连接点 + 矩形
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const rawPins = pins.map((p) => {
      const at = find(p, 'at');
      const len = num(find(p, 'length'), 1) || 2.54;
      const x = num(at, 1), y = num(at, 2), ang = num(at, 3);
      const rad = (ang * Math.PI) / 180;
      // 引脚从连接点(at)沿角度方向延伸 length 指向本体
      const ex = x + Math.cos(rad) * len, ey = y + Math.sin(rad) * len;
      const nameL = find(p, 'name'), numL = find(p, 'number');
      minX = Math.min(minX, x, ex); maxX = Math.max(maxX, x, ex);
      minY = Math.min(minY, y, ey); maxY = Math.max(maxY, y, ey);
      return { x, y, ex, ey, ang, name: String(nameL?.[1] ?? ''), number: String(numL?.[1] ?? '') };
    });
    const rawRects = rects.map((r) => {
      const s1 = find(r, 'start'), e1 = find(r, 'end');
      const x1 = num(s1, 1), y1 = num(s1, 2), x2 = num(e1, 1), y2 = num(e1, 2);
      minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
      return { x1, y1, x2, y2 };
    });
    // 原点平移量对齐 2.54 栅格 → 端口像素坐标保持 10px 栅格
    const g = 2.54;
    const ox = Math.floor(minX / g) * g;
    const oyTop = Math.ceil(maxY / g) * g;
    const toPx = (x: number, y: number) => ({ x: (x - ox) * S, y: (oyTop - y) * S });
    const wh = toPx(Math.ceil(maxX / g) * g, Math.floor(minY / g) * g);

    return {
      w: wh.x, h: wh.y,
      rects: rawRects.map((r) => {
        const a = toPx(Math.min(r.x1, r.x2), Math.max(r.y1, r.y2));
        return { x: a.x, y: a.y, w: Math.abs(r.x2 - r.x1) * S, h: Math.abs(r.y2 - r.y1) * S };
      }),
      pins: rawPins.map((p) => {
        const tip = toPx(p.x, p.y), end = toPx(p.ex, p.ey);
        // 引脚名靠本体端，编号在线中上方
        const mid = { x: (tip.x + end.x) / 2, y: (tip.y + end.y) / 2 };
        return {
          tipX: tip.x, tipY: tip.y, endX: end.x, endY: end.y,
          name: p.name === '~' ? '' : p.name, number: p.number,
          nameX: end.x + (end.x >= tip.x ? 3 : -3), nameY: end.y + 2.5,
          numX: mid.x, numY: mid.y - 2,
        };
      }),
    };
  } catch {
    return null;
  }
}

/** 按需拉取并注册符号文件（key = mpn） */
export function ensureSymbolFile(mpn: string, url: string | undefined) {
  if (!url || symbolOverrides.has(mpn) || inflight.has(url) || failed.has(url)) return;
  inflight.add(url);
  fetchViaProxy(url).then((text) => {
    inflight.delete(url);
    const parsed = text ? parseKicadSym(text) : null;
    if (parsed) {
      symbolOverrides.set(mpn, parsed);
      useLibFileStore.getState().bump();
    } else {
      failed.add(url);
      console.warn('[libfile] 符号文件解析失败，回退内置符号:', mpn, url);
    }
  });
}

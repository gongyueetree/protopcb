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
  /** 多边形/折线（运放三角形等），SVG path d */
  polys: string[];
  circles: { x: number; y: number; r: number }[];
  pins: { tipX: number; tipY: number; endX: number; endY: number; name: string; number: string; nameX: number; nameY: number; numX: number; numY: number }[];
  /** 多单元符号（双运放等）：各单元独立几何，原理图可分开摆放 */
  units?: ParsedSymbol[];
}
const symbolOverrides = new Map<string, ParsedSymbol>(); // key: mpn（拼合版，详情预览用）
const symbolUnitsOverrides = new Map<string, ParsedSymbol[]>(); // key: mpn（分单元，原理图独立摆放用）

export function footprintOverrideFor(name: string): PadFootprint | undefined {
  return footprintOverrides.get(name);
}
export function symbolOverrideFor(mpn: string): ParsedSymbol | undefined {
  return symbolOverrides.get(mpn);
}
export function symbolUnitsOverrideFor(mpn: string): ParsedSymbol[] | undefined {
  return symbolUnitsOverrides.get(mpn);
}

/** 定制器件库等外部来源注册符号/封装覆盖 */
export function registerSymbolOverride(mpn: string, ps: ParsedSymbol) {
  symbolOverrides.set(mpn, ps);
  useLibFileStore.getState().bump();
}
export function registerFootprintOverride(name: string, fp: PadFootprint) {
  footprintOverrides.set(name, fp);
  useLibFileStore.getState().bump();
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

export type LibFileStatus = 'loaded' | 'loading' | 'failed' | 'nourl';

/** 库文件加载状态（详情面板可见提示用） */
export function footprintFileStatus(fpName: string, url: string | undefined): LibFileStatus {
  if (footprintOverrides.has(fpName)) return 'loaded';
  if (!url) return 'nourl';
  if (inflight.has(url)) return 'loading';
  if (failed.has(url)) return 'failed';
  return 'loading';
}
export function symbolFileStatus(mpn: string, url: string | undefined): LibFileStatus {
  if (symbolOverrides.has(mpn)) return 'loaded';
  if (!url) return 'nourl';
  if (inflight.has(url)) return 'loading';
  if (failed.has(url)) return 'failed';
  return 'loading';
}

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

/** 三点弧 → 折线采样 path（16 段）：px 空间求圆心，扫向经中点校验，避免 SVG 弧 flag 边界问题 */
function arcToPath(p1: { x: number; y: number }, pm: { x: number; y: number }, p2: { x: number; y: number }): string | null {
  const ax = p1.x, ay = p1.y, bx = pm.x, by = pm.y, cx = p2.x, cy = p2.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-6) return `M${ax.toFixed(1)},${ay.toFixed(1)} L${cx.toFixed(1)},${cy.toFixed(1)}`; // 三点共线退化为直线
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a1 = Math.atan2(ay - uy, ax - ux);
  const amid = Math.atan2(by - uy, bx - ux);
  const a2 = Math.atan2(cy - uy, cx - ux);
  const norm = (t: number) => { let v = t; while (v < 0) v += Math.PI * 2; return v % (Math.PI * 2); };
  // 逆时针扫过量；若中点不在该方向弧上则反向
  let sweep = norm(a2 - a1);
  if (norm(amid - a1) > sweep + 1e-9) sweep = sweep - Math.PI * 2;
  const N = 16;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = a1 + (sweep * i) / N;
    pts.push(`${i === 0 ? 'M' : 'L'}${(ux + r * Math.cos(t)).toFixed(1)},${(uy + r * Math.sin(t)).toFixed(1)}`);
  }
  return pts.join(' ');
}

export function parseKicadSym(text: string): ParsedSymbol | null {
  try {
    const roots = parseSExpr(text);
    const lib = roots.find((r): r is SExpr[] => isList(r) && head(r) === 'kicad_symbol_lib');
    const symRoot = lib ? find(lib, 'symbol') : roots.find((r): r is SExpr[] => isList(r) && head(r) === 'symbol');
    if (!symRoot) return null;

    // 按【单元】分组收集图形与引脚（多单元符号如双运放 LM358：_1_1/_2_1/_3_1；_0_* 为公共图形）
    interface RawUnit { rects: SExpr[][]; polys: SExpr[][]; circles: SExpr[][]; arcs: SExpr[][]; pins: SExpr[][] }
    const units = new Map<number, RawUnit>();
    const unitOf = (name: string): number => {
      const m = name.match(/_(\d+)_\d+$/);
      return m ? parseInt(m[1], 10) : 1;
    };
    const bucket = (u: number): RawUnit => {
      if (!units.has(u)) units.set(u, { rects: [], polys: [], circles: [], arcs: [], pins: [] });
      return units.get(u)!;
    };
    // 根符号直挂的图形归单元 1
    const rootB = bucket(1);
    rootB.rects.push(...findAll(symRoot, 'rectangle'));
    rootB.polys.push(...findAll(symRoot, 'polyline'));
    rootB.circles.push(...findAll(symRoot, 'circle'));
    rootB.arcs.push(...findAll(symRoot, 'arc'));
    rootB.pins.push(...findAll(symRoot, 'pin'));
    for (const sub of findAll(symRoot, 'symbol')) {
      const u = unitOf(String(sub[1] ?? ''));
      const b = bucket(u);
      b.rects.push(...findAll(sub, 'rectangle'));
      b.polys.push(...findAll(sub, 'polyline'));
      b.circles.push(...findAll(sub, 'circle'));
      b.arcs.push(...findAll(sub, 'arc'));
      b.pins.push(...findAll(sub, 'pin'));
    }
    // 公共单元 0 合并进最小编号的实际单元
    const realUnits = [...units.keys()].filter((u) => u > 0).sort((a, b) => a - b);
    if (units.has(0) && realUnits.length) {
      const tgt = bucket(realUnits[0]), src = units.get(0)!;
      tgt.rects.push(...src.rects); tgt.polys.push(...src.polys);
      tgt.circles.push(...src.circles); tgt.arcs.push(...src.arcs); tgt.pins.push(...src.pins);
      units.delete(0);
    }
    const g = 2.54;
    const S2 = S; // px per mm
    // 逐单元解析原始 mm 坐标并计算包围盒
    const parsedUnits = realUnits.map((u) => {
      const b = units.get(u)!;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const grow = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
      const pins = b.pins.map((pn) => {
        const at = find(pn, 'at');
        const len = num(find(pn, 'length'), 1) || 2.54;
        const x = num(at, 1), y = num(at, 2), ang = num(at, 3);
        const rad = (ang * Math.PI) / 180;
        const ex = x + Math.cos(rad) * len, ey = y + Math.sin(rad) * len;
        grow(x, y); grow(ex, ey);
        const nameL = find(pn, 'name'), numL = find(pn, 'number');
        return { x, y, ex, ey, name: String(nameL?.[1] ?? ''), number: String(numL?.[1] ?? '') };
      });
      const rects = b.rects.map((r) => {
        const s1 = find(r, 'start'), e1 = find(r, 'end');
        const x1 = num(s1, 1), y1 = num(s1, 2), x2 = num(e1, 1), y2 = num(e1, 2);
        grow(x1, y1); grow(x2, y2);
        return { x1, y1, x2, y2 };
      });
      const polys = b.polys.map((pl) => {
        const pts = find(pl, 'pts');
        const xy = pts ? findAll(pts, 'xy').map((q) => ({ x: num(q, 1), y: num(q, 2) })) : [];
        xy.forEach((q) => grow(q.x, q.y));
        return xy;
      }).filter((xy) => xy.length >= 2);
      const arcs = b.arcs.map((ar) => {
        const s1 = find(ar, 'start'), m1 = find(ar, 'mid'), e1 = find(ar, 'end');
        if (!s1 || !m1 || !e1) return null;
        const a = { x1: num(s1, 1), y1: num(s1, 2), xm: num(m1, 1), ym: num(m1, 2), x2: num(e1, 1), y2: num(e1, 2) };
        grow(a.x1, a.y1); grow(a.xm, a.ym); grow(a.x2, a.y2);
        return a;
      }).filter((a): a is NonNullable<typeof a> => !!a);
      const circles = b.circles.map((ci) => {
        const c1 = find(ci, 'center');
        const r1 = num(find(ci, 'radius'), 1);
        const cx = num(c1, 1), cy = num(c1, 2);
        grow(cx - r1, cy - r1); grow(cx + r1, cy + r1);
        return { cx, cy, r: r1 };
      });
      if (!pins.length && !rects.length && !polys.length && !arcs.length) return null;
      if (!Number.isFinite(minX)) { minX = 0; maxX = 0; minY = 0; maxY = 0; }
      return { pins, rects, polys, circles, arcs, minX, maxX, minY, maxY };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    if (!parsedUnits.length || !parsedUnits.some((u) => u.pins.length)) return null;

    // 每单元先各自归一化为独立 ParsedSymbol（原理图可分开摆放）
    const unitSymbols: ParsedSymbol[] = [];
    // 单元水平排布拼合版（详情预览用）：x 偏移取 10px 倍数
    const out: ParsedSymbol = { w: 0, h: 0, rects: [], polys: [], circles: [], pins: [], units: unitSymbols };
    let xCursor = 0;
    for (const un of parsedUnits) {
      const ox = Math.floor(un.minX / g) * g;
      const oyTop = Math.ceil(un.maxY / g) * g;
      const toPx = (x: number, y: number) => ({ x: xCursor + (x - ox) * S2, y: (oyTop - y) * S2 });
      const wh = { w: (Math.ceil(un.maxX / g) * g - ox) * S2, h: (oyTop - Math.floor(un.minY / g) * g) * S2 };
      for (const r of un.rects) {
        const a = toPx(Math.min(r.x1, r.x2), Math.max(r.y1, r.y2));
        out.rects.push({ x: a.x, y: a.y, w: Math.abs(r.x2 - r.x1) * S2, h: Math.abs(r.y2 - r.y1) * S2 });
      }
      for (const pl of un.polys) {
        const d = pl.map((q, i) => { const a = toPx(q.x, q.y); return `${i === 0 ? 'M' : 'L'}${a.x.toFixed(1)},${a.y.toFixed(1)}`; }).join(' ');
        out.polys.push(d);
      }
      for (const ci of un.circles) {
        const a = toPx(ci.cx, ci.cy);
        out.circles.push({ x: a.x, y: a.y, r: ci.r * S2 });
      }
      for (const ar of un.arcs) {
        const d = arcToPath(toPx(ar.x1, ar.y1), toPx(ar.xm, ar.ym), toPx(ar.x2, ar.y2));
        if (d) out.polys.push(d);
      }
      for (const p of un.pins) {
        const tip = toPx(p.x, p.y), end = toPx(p.ex, p.ey);
        out.pins.push({
          tipX: tip.x, tipY: tip.y, endX: end.x, endY: end.y,
          name: p.name === '~' ? '' : p.name, number: p.number,
          nameX: end.x + (end.x >= tip.x ? 3 : -3), nameY: end.y + 2.5,
          numX: (tip.x + end.x) / 2, numY: (tip.y + end.y) / 2 - 2,
        });
      }
      // 独立单元版本（局部坐标从 0 开始）
      const toPx0 = (x: number, y: number) => ({ x: (x - ox) * S2, y: (oyTop - y) * S2 });
      unitSymbols.push({
        w: wh.w, h: wh.h,
        rects: un.rects.map((r) => { const a = toPx0(Math.min(r.x1, r.x2), Math.max(r.y1, r.y2)); return { x: a.x, y: a.y, w: Math.abs(r.x2 - r.x1) * S2, h: Math.abs(r.y2 - r.y1) * S2 }; }),
        polys: [
          ...un.polys.map((pl) => pl.map((q, i) => { const a = toPx0(q.x, q.y); return `${i === 0 ? 'M' : 'L'}${a.x.toFixed(1)},${a.y.toFixed(1)}`; }).join(' ')),
          ...un.arcs.map((ar) => arcToPath(toPx0(ar.x1, ar.y1), toPx0(ar.xm, ar.ym), toPx0(ar.x2, ar.y2))).filter((d): d is string => !!d),
        ],
        circles: un.circles.map((ci) => { const a = toPx0(ci.cx, ci.cy); return { x: a.x, y: a.y, r: ci.r * S2 }; }),
        pins: un.pins.map((pp) => {
          const tip = toPx0(pp.x, pp.y), end = toPx0(pp.ex, pp.ey);
          return { tipX: tip.x, tipY: tip.y, endX: end.x, endY: end.y, name: pp.name === '~' ? '' : pp.name, number: pp.number,
            nameX: end.x + (end.x >= tip.x ? 3 : -3), nameY: end.y + 2.5, numX: (tip.x + end.x) / 2, numY: (tip.y + end.y) / 2 - 2 };
        }),
      });
      out.h = Math.max(out.h, wh.h);
      xCursor += Math.ceil((wh.w + 20) / 10) * 10; // 单元间隔，保持 10px 栅格
    }
    out.w = Math.max(10, xCursor - 20);
    return out;
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
      if (parsed.units && parsed.units.length > 1) symbolUnitsOverrides.set(mpn, parsed.units);
      useLibFileStore.getState().bump();
    } else {
      failed.add(url);
      console.warn('[libfile] 符号文件解析失败，回退内置符号:', mpn, url);
    }
  });
}

// ── KiCad 官方符号自愈：override 是内存态，刷新即失；symbolFromMpn 里的
//    KICADSYM:lib:name 编码了完整来源，缺失时自动重拉注册（localStorage 加速） ──
const ksymInflight = new Set<string>();
const ksymStatus = new Map<string, string>();
/** KICADSYM 自愈状态（供 UI 展示：拉取中/失败原因） */
export function kicadSymbolStatus(key: string | undefined): string | undefined {
  return key ? ksymStatus.get(key) : undefined;
}
function setKsymStatus(key: string, st: string) {
  ksymStatus.set(key, st);
  useLibFileStore.getState().bump();
}
export function ensureKicadSymbol(key: string | undefined): void {
  if (!key || symbolOverrideFor(key) || ksymInflight.has(key)) return;
  // KICADSCH:*（工程 zip 内嵌符号）只有 localStorage 一个复原源
  if (key.startsWith('KICADSCH:')) {
    try {
      const cached = localStorage.getItem('cc_ksym_' + key);
      if (cached) {
        const ps = parseKicadSym(cached);
        if (ps && ps.pins.length) registerSymbolOverride(key, ps);
      }
    } catch { /* 忽略 */ }
    return;
  }
  if (!key.startsWith('KICADSYM:')) return;
  const parts = key.split(':');
  const lib = parts[1];
  const name = parts.slice(2).join(':');
  if (!lib || !name) return;
  ksymInflight.add(key);
  setKsymStatus(key, '符号自动恢复中…');
  const cacheK = 'cc_ksym_' + key;
  const apply = (text: string): boolean => {
    const ps = parseKicadSym(text);
    if (ps && ps.pins.length) { registerSymbolOverride(key, ps); setKsymStatus(key, '✓'); return true; }
    setKsymStatus(key, `解析失败（${ps ? '0管脚' : '格式异常'}；开头：${text.slice(0, 40).replace(/\s+/g, ' ')}）`);
    return false;
  };
  try {
    const cached = localStorage.getItem(cacheK);
    if (cached && apply(cached)) { ksymInflight.delete(key); return; }
  } catch { /* localStorage 不可用则直接走网络 */ }
  fetch(`/api/kicadlib?path=sym&lib=${encodeURIComponent(lib)}&name=${encodeURIComponent(name)}`)
    .then(async (r) => {
      if (r.ok) return r.text();
      let d = '';
      try { d = String((await r.json())?.error ?? ''); } catch { /* 非 JSON */ }
      throw new Error(`HTTP ${r.status}${d ? ' · ' + d : ''}`);
    })
    .then((text) => {
      try { localStorage.setItem(cacheK, text); } catch { /* 空间不足忽略 */ }
      apply(text);
    })
    .catch((e) => {
      setKsymStatus(key, `拉取失败：${(e as Error).message}`);
      console.warn('[ksym]', key, e);
    })
    .then(() => ksymInflight.delete(key));
}

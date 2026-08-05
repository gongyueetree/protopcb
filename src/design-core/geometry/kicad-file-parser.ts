/**
 * design-core/geometry/kicad-file-parser.ts
 * KiCad 库文件运行时解析 —— 从 ezPLM 返回的真实 .kicad_mod 文件解析【逐点精确】的焊盘。
 * 有真实文件时优先于名字参数化解析（kicad-name-parser 仅作拉取中/失败的兜底）。
 */
import type { PadFootprint, Pad } from './footprint-pads';

/* ---------- 轻量 S-表达式解析 ---------- */
export type SExpr = string | SExpr[];

export function parseSExpr(text: string): SExpr[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(' || ch === ')') { tokens.push(ch); i++; }
    else if (ch === '"') {
      let j = i + 1, out = '';
      while (j < text.length && text[j] !== '"') { out += text[j] === '\\' ? text[++j] : text[j]; j++; }
      tokens.push(out); i = j + 1;
    } else if (/\s/.test(ch)) i++;
    else {
      let j = i, out = '';
      while (j < text.length && !/[\s()]/.test(text[j])) { out += text[j]; j++; }
      tokens.push(out); i = j;
    }
  }
  let pos = 0;
  const walk = (): SExpr => {
    const t = tokens[pos++];
    if (t !== '(') return t;
    const list: SExpr[] = [];
    while (pos < tokens.length && tokens[pos] !== ')') list.push(walk());
    pos++; // skip ')'
    return list;
  };
  const roots: SExpr[] = [];
  while (pos < tokens.length) roots.push(walk());
  return roots;
}

const isList = (e: SExpr): e is SExpr[] => Array.isArray(e);
const head = (e: SExpr): string => (isList(e) ? String(e[0]) : String(e));
/** 在列表中找第一个以 tag 开头的子列表 */
function find(list: SExpr[], tag: string): SExpr[] | undefined {
  return list.find((e): e is SExpr[] => isList(e) && head(e) === tag);
}
function findAll(list: SExpr[], tag: string): SExpr[][] {
  return list.filter((e): e is SExpr[] => isList(e) && head(e) === tag);
}
const numAt = (l: SExpr[] | undefined, i: number): number => (l ? parseFloat(String(l[i])) || 0 : 0);

/* ---------- .kicad_mod → PadFootprint ---------- */

/** 解析 .kicad_mod 文本为逐点精确的焊盘数据；解析失败返回 null */
export function parseKicadMod(text: string): PadFootprint | null {
  try {
    const roots = parseSExpr(text);
    const fp = roots.find((r): r is SExpr[] => isList(r) && (head(r) === 'footprint' || head(r) === 'module'));
    if (!fp) return null;

    const pads: Pad[] = [];
    let autoNum = 0;
    for (const p of findAll(fp, 'pad')) {
      // (pad "1" smd roundrect (at x y [rot]) (size w h) [(drill d)] (layers ...))
      const numRaw = String(p[1] ?? '');
      const type = String(p[2] ?? '');
      const shape = String(p[3] ?? '');
      const at = find(p, 'at');
      const size = find(p, 'size');
      if (!at || !size) continue;
      const rot = numAt(at, 3) % 180;
      let w = numAt(size, 1), h = numAt(size, 2);
      if (Math.abs(rot) === 90) [w, h] = [h, w]; // 旋转 90° 的焊盘等效交换宽高
      const round = shape === 'circle' || shape === 'oval' || type === 'thru_hole' || type === 'np_thru_hole';
      const num = parseInt(numRaw, 10);
      pads.push({ x: numAt(at, 1), y: numAt(at, 2), w, h, num: Number.isFinite(num) ? num : ++autoNum, round });
    }
    if (!pads.length) return null;

    // 本体外框：优先 F.Fab 的 fp_rect / fp_line 范围，其次 F.SilkS，最后按焊盘范围收缩
    const outline = (layer: string) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, hit = false;
      for (const tag of ['fp_rect', 'fp_line'] as const) {
        for (const g of findAll(fp, tag)) {
          const ly = find(g, 'layer');
          if (!ly || String(ly[1]) !== layer) continue;
          const s1 = find(g, 'start'), e1 = find(g, 'end');
          if (!s1 || !e1) continue;
          hit = true;
          minX = Math.min(minX, numAt(s1, 1), numAt(e1, 1));
          maxX = Math.max(maxX, numAt(s1, 1), numAt(e1, 1));
          minY = Math.min(minY, numAt(s1, 2), numAt(e1, 2));
          maxY = Math.max(maxY, numAt(s1, 2), numAt(e1, 2));
        }
      }
      return hit ? { w: maxX - minX, h: maxY - minY } : null;
    };
    const body = outline('F.Fab') ?? outline('F.SilkS');
    const padExtW = Math.max(...pads.map((p) => Math.abs(p.x) + p.w / 2)) * 2;
    const padExtH = Math.max(...pads.map((p) => Math.abs(p.y) + p.h / 2)) * 2;
    const bodyW = body?.w || Math.max(0.5, padExtW * 0.72);
    const bodyH = body?.h || Math.max(0.5, padExtH * 0.72);

    // 引脚1标记：1 号焊盘位置
    const p1 = pads.find((p) => p.num === 1);
    return { bodyW: +bodyW.toFixed(3), bodyH: +bodyH.toFixed(3), pads, pin1: p1 ? { x: p1.x, y: p1.y } : undefined };
  } catch {
    return null;
  }
}

/**
 * design-core/geometry/kicad-pcb-import.ts
 * KiCad 工程导入 —— 解析 .kicad_pcb（兼容 v6~v10 格式）：
 *   器件（footprint/module 节点，位置/旋转/层/位号/型号）
 *   板框（Edge.Cuts 图元包围盒 → 板尺寸，坐标归一化到左上原点）
 *   定位孔（MountingHole 封装 → 开启四角定位孔，不作为器件导入）
 */
import { parseSExpr, parseFootprintNode, type SExpr } from './kicad-file-parser';
import type { PadFootprint } from './footprint-pads';

const isList = (x: SExpr): x is SExpr[] => Array.isArray(x);
const head = (x: SExpr[]): string => String(x[0] ?? '');
const find = (list: SExpr[], key: string): SExpr[] | undefined =>
  list.find((x): x is SExpr[] => isList(x) && head(x) === key);
const findAll = (list: SExpr[], key: string): SExpr[][] =>
  list.filter((x): x is SExpr[] => isList(x) && head(x) === key);
const num = (l: SExpr[] | undefined, i: number): number => {
  const v = l?.[i];
  const n = typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

export interface KicadImportedComp {
  reference: string;
  /** 焊盘号 → 网络号（来自源文件，导出时写回） */
  padNets?: Record<string, number>;
  value: string;
  footprintName: string;
  xMm: number;
  yMm: number;
  rotation: number;
  layer: 'top' | 'bottom';
}

export interface KicadImportResult {
  /** 网络表：网络号 → 网络名（导出时原样写回，保留电气连接） */
  nets: Record<number, string>;
  /** 铜箔走线（原始线宽，坐标已归一化到板左上原点） */
  tracks: { x1: number; y1: number; x2: number; y2: number; w: number; layer: 'top' | 'bottom' }[];
  /** 过孔（外径） */
  vias: { x: number; y: number; size: number }[];
  /** 板框左上角在 KiCad 图纸中的绝对坐标（器件坐标需减去它） */
  originXMm: number;
  originYMm: number;
  widthMm: number;
  heightMm: number;
  comps: KicadImportedComp[];
  hasMountingHoles: boolean;
  /** 真实定位孔（板坐标，已归一化） */
  mountingHoles: { x: number; y: number; d: number }[];
  skipped: string[];
  /** PCB 文件内嵌的完整封装定义（KiCad 文件自包含）：注册为覆盖后所有导入器件焊盘精确 */
  footprintDefs: Record<string, PadFootprint>;
  /** 各封装名 → KiCad 官方 3D 引用（3dshapes 目录基名 + 模型基名），来自内嵌 (model) */
  modelRefs: Record<string, { lib3d: string; name3d: string }>;
}

/** 读取 footprint 的文本属性：v7+ (property "Reference" "U1") / v6 (fp_text reference U1 …) */
function fpProperty(fp: SExpr[], key: 'Reference' | 'Value'): string {
  for (const p of findAll(fp, 'property')) {
    if (String(p[1]) === key) return String(p[2] ?? '');
  }
  for (const t of findAll(fp, 'fp_text')) {
    if (String(t[1]).toLowerCase() === key.toLowerCase()) return String(t[2] ?? '');
  }
  return '';
}

export function parseKicadPcb(text: string): KicadImportResult {
  const roots = parseSExpr(text);
  const pcb = roots.find((r): r is SExpr[] => isList(r) && head(r) === 'kicad_pcb');
  if (!pcb) throw new Error('不是有效的 .kicad_pcb 文件（未找到 kicad_pcb 根节点）');

  // ── 板框：Edge.Cuts 图元包围盒 ──
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  const onEdgeCuts = (el: SExpr[]) => String(find(el, 'layer')?.[1] ?? '') === 'Edge.Cuts';
  for (const key of ['gr_line', 'gr_rect', 'gr_arc', 'gr_curve', 'gr_poly', 'gr_circle']) {
    for (const el of findAll(pcb, key)) {
      if (!onEdgeCuts(el)) continue;
      if (key === 'gr_circle') {
        const c = find(el, 'center'), e = find(el, 'end');
        const r = Math.hypot(num(e, 1) - num(c, 1), num(e, 2) - num(c, 2));
        grow(num(c, 1) - r, num(c, 2) - r); grow(num(c, 1) + r, num(c, 2) + r);
        continue;
      }
      if (key === 'gr_poly') {
        const pts = find(el, 'pts');
        if (pts) for (const xy of findAll(pts, 'xy')) grow(num(xy, 1), num(xy, 2));
        continue;
      }
      for (const ptKey of ['start', 'mid', 'end']) {
        const pt = find(el, ptKey);
        if (pt) grow(num(pt, 1), num(pt, 2));
      }
    }
  }
  const hasOutline = Number.isFinite(minX);

  // ── 器件 ──
  const fps = [...findAll(pcb, 'footprint'), ...findAll(pcb, 'module')];
  const comps: KicadImportedComp[] = [];
  const skipped: string[] = [];
  const footprintDefs: Record<string, PadFootprint> = {};
  const modelRefs: Record<string, { lib3d: string; name3d: string }> = {};
  // 顶层网络表：(net 3 +5V) / (net 1 "Net-(R20-Pad1)")
  const nets: Record<number, string> = {};
  for (const n of findAll(pcb, 'net')) {
    const id = Number(n[1]);
    if (Number.isFinite(id)) nets[id] = String(n[2] ?? '').replace(/^"|"$/g, '');
  }
  let hasMountingHoles = false;
  const mountingHoles: { x: number; y: number; d: number }[] = [];
  for (const fp of fps) {
    const lib = String(fp[1] ?? '');
    const fpName = lib.includes(':') ? lib.split(':').pop()! : lib;
    if (/mountinghole|^hole[_-]|_hole_/i.test(fpName)) {
      hasMountingHoles = true;
      const at2 = find(fp, 'at');
      if (at2) {
        // 孔径取该封装内最大钻孔
        let d = 3;
        for (const pd of findAll(fp, 'pad')) {
          const dr = find(pd, 'drill');
          if (dr) d = Math.max(d, num(dr, 1) || 3);
        }
        mountingHoles.push({ x: num(at2, 1), y: num(at2, 2), d });
      }
      continue;
    }
    // 提取内嵌焊盘定义（首次出现为准；同名封装在 KiCad 内定义一致）
    if (!footprintDefs[fpName]) {
      const def = parseFootprintNode(fp);
      if (def && def.pads.length) footprintDefs[fpName] = def;
      // 内嵌 (model "…/X.3dshapes/Y.wrl|step") → 官方 3D 引用
      const mdl = find(fp, 'model');
      const mpath = mdl ? String(mdl[1] ?? '') : '';
      const mm = mpath.match(/([^/\\]+)\.3dshapes[/\\]([^/\\]+)\.(step|stp|wrl)$/i);
      if (mm) modelRefs[fpName] = { lib3d: mm[1], name3d: mm[2] };
    }
    const at = find(fp, 'at');
    const layerRaw = String(find(fp, 'layer')?.[1] ?? 'F.Cu');
    const reference = fpProperty(fp, 'Reference');
    const value = fpProperty(fp, 'Value');
    if (!at) { skipped.push(fpName); continue; }
    // 器件包围盒也参与板框推断（无 Edge.Cuts 时兜底）
    grow(num(at, 1), num(at, 2));
    // 焊盘网络：pad 内嵌 (net id "name")
    const padNets: Record<string, number> = {};
    for (const pd of findAll(fp, 'pad')) {
      const pnum = String(pd[1] ?? '').replace(/^"|"$/g, '');
      const nn = find(pd, 'net');
      if (pnum && nn && Number.isFinite(Number(nn[1]))) padNets[pnum] = Number(nn[1]);
    }
    comps.push({
      padNets: Object.keys(padNets).length ? padNets : undefined,
      reference: reference || `X${comps.length + 1}`,
      value: value || fpName,
      footprintName: fpName,
      xMm: num(at, 1),
      yMm: num(at, 2),
      rotation: ((num(at, 3) % 360) + 360) % 360,
      layer: layerRaw.startsWith('B') ? 'bottom' : 'top',
    });
  }
  // ── 走线与过孔（真实线宽；随器件同一原点归一化）──
  const tracks: { x1: number; y1: number; x2: number; y2: number; w: number; layer: 'top' | 'bottom' }[] = [];
  for (const seg of findAll(pcb, 'segment')) {
    const st = find(seg, 'start'), en = find(seg, 'end'), wd = find(seg, 'width');
    const ly = String(find(seg, 'layer')?.[1] ?? '');
    if (!st || !en) continue;
    tracks.push({ x1: num(st, 1), y1: num(st, 2), x2: num(en, 1), y2: num(en, 2), w: wd ? num(wd, 1) : 0.25, layer: ly.startsWith('B') ? 'bottom' : 'top' });
  }
  const viasArr: { x: number; y: number; size: number }[] = [];
  for (const v of findAll(pcb, 'via')) {
    const at = find(v, 'at'), sz = find(v, 'size');
    if (!at) continue;
    viasArr.push({ x: num(at, 1), y: num(at, 2), size: sz ? num(sz, 1) : 0.6 });
  }

  if (!comps.length) throw new Error('文件中没有可导入的器件');

  // ── 归一化：左上角 → (0,0)，无板框时按器件范围加边距 ──
  const pad = hasOutline ? 0 : 10;
  const ox = (Number.isFinite(minX) ? minX : 0) - pad;
  const oy = (Number.isFinite(minY) ? minY : 0) - pad;
  for (const c of comps) { c.xMm -= ox; c.yMm -= oy; }
  for (const t2 of tracks) { t2.x1 -= ox; t2.y1 -= oy; t2.x2 -= ox; t2.y2 -= oy; }
  for (const v2 of viasArr) { v2.x -= ox; v2.y -= oy; }
  for (const h2 of mountingHoles) { h2.x -= ox; h2.y -= oy; }
  const widthMm = Math.max(20, Math.ceil((maxX - ox + pad)));
  const heightMm = Math.max(20, Math.ceil((maxY - oy + pad)));

  return { nets, tracks, vias: viasArr, mountingHoles, widthMm, heightMm, originXMm: hasOutline ? minX : 0, originYMm: hasOutline ? minY : 0, comps, hasMountingHoles, skipped, footprintDefs, modelRefs };
}

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
  /**
   * 铜箔走线（原始线宽，坐标已归一化到板左上原点）。
   * layer：F.Cu→'top'、B.Cu→'bottom'，内层保留 KiCad 原名（In1.Cu…）；
   * net：源文件 (net N) 原值 —— 导出时写回，铜线电气归属不丢失。
   */
  tracks: { x1: number; y1: number; x2: number; y2: number; w: number; layer: string; net?: number }[];
  /** 过孔：size/drill/layers/net 均为源文件原值，不做任何猜测 */
  vias: { x: number; y: number; size: number; drill?: number; net?: number; layers?: [string, string]; viaType?: 'blind' | 'micro' }[];
  /** 铜层栈（KiCad 层名，按文件层表顺序；至少 [F.Cu, B.Cu]） */
  copperLayers: string[];
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
  /** 封装名 → 工程自带 3D 模型的原始路径（如 ${KIPRJMOD}/3D/evqp7-ja-01p.step） */
  projectModelPaths: Record<string, string>;
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
  /** 封装名 → .kicad_pcb 里写的原始 model 路径（可能含 ${KIPRJMOD} 变量） */
  const projectModelPaths: Record<string, string> = {};
  /**
   * 网络表。两种格式都要支持：
   *   KiCad ≤9：文件顶层有 (net 3 "+5V") 编号表，pad 里写 (net 3 "+5V")
   *   KiCad 10（version 20260206+）：**取消了顶层编号表**，pad 里只写 (net "+5V")
   * 后者若按旧格式解析，一个网络都认不出来 —— 导入的板会全部显示"没有网络连接数据"。
   * 对新格式我们自行编号（按首次出现顺序），编号只在本次导入内有意义。
   */
  const nets: Record<number, string> = {};
  const netIdByName = new Map<string, number>();
  let nextNetId = 1;
  const netIdOf = (rawName: string): number => {
    const name = rawName.replace(/^"|"$/g, '');
    const existing = netIdByName.get(name);
    if (existing != null) return existing;
    const id = nextNetId++;
    netIdByName.set(name, id);
    nets[id] = name;
    return id;
  };
  for (const n of findAll(pcb, 'net')) {
    const id = Number(n[1]);
    if (!Number.isFinite(id)) continue;                       // 新格式的 (net "名字")：留给 netIdOf 按需编号
    const name = String(n[2] ?? '').replace(/^"|"$/g, '');
    nets[id] = name;
    if (name) netIdByName.set(name, id);
    nextNetId = Math.max(nextNetId, id + 1);
  }
  // ── 铜层栈：解析 (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) …) 中的 *.Cu 层 ──
  // 4/6 层板的 In1.Cu/In2.Cu 必须保留原名，绝不能压成 TOP/BOTTOM。
  const copperLayers: string[] = [];
  const layerTable = find(pcb, 'layers');
  if (layerTable) {
    for (const entry of layerTable) {
      if (!isList(entry)) continue;
      const lname = String(entry[1] ?? '').replace(/^"|"$/g, '');
      if (/\.Cu$/.test(lname)) copperLayers.push(lname);
    }
  }
  if (!copperLayers.length) copperLayers.push('F.Cu', 'B.Cu');

  let hasMountingHoles = false;
  const mountingHoles: { x: number; y: number; d: number }[] = [];
  for (const fp of fps) {
    const lib = String(fp[1] ?? '');
    const fpName = lib.includes(':') ? lib.split(':').pop()! : lib;
    if (/mountinghole|^hole[_-]|_hole_/i.test(fpName)) {
      hasMountingHoles = true;
      const at2 = find(fp, 'at');
      if (at2) {
        // 孔径取该封装内最大真实钻孔；此前写死 3mm 下限 → 2.7mm 孔被抬成 3mm（保真丢失）
        let d = 0;
        for (const pd of findAll(fp, 'pad')) {
          const dr = find(pd, 'drill');
          if (dr) d = Math.max(d, num(dr, 1));
        }
        mountingHoles.push({ x: num(at2, 1), y: num(at2, 2), d: d > 0 ? d : 3 });
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
      // 工程自带模型（${KIPRJMOD}/3D/xxx.step 这类）：记下原始路径，zip 导入时按文件名在包内匹配
      if (mpath && /\.(step|stp)$/i.test(mpath) && !/\.3dshapes[/\\]/i.test(mpath)) projectModelPaths[fpName] = mpath;
    }
    const at = find(fp, 'at');
    const layerRaw = String(find(fp, 'layer')?.[1] ?? 'F.Cu');
    const reference = fpProperty(fp, 'Reference');
    const value = fpProperty(fp, 'Value');
    if (!at) { skipped.push(fpName); continue; }
    // 器件包围盒也参与板框推断（无 Edge.Cuts 时兜底）
    // 板框以 Edge.Cuts 为准：器件坐标只在"没有有效 Edge.Cuts"时才用于兜底推断。
    // 否则 USB-C/HDMI 这类外伸连接器会把板框撑大，与原工程不符。
    if (!hasOutline) grow(num(at, 1), num(at, 2));
    // 焊盘网络：pad 内嵌 (net id "name")
    const padNets: Record<string, number> = {};
    for (const pd of findAll(fp, 'pad')) {
      const pnum = String(pd[1] ?? '').replace(/^"|"$/g, '');
      const nn = find(pd, 'net');
      if (!pnum || !nn) continue;
      // (net 3 "+5V") → 直接用编号；(net "+5V") → 按名字取/分配编号（KiCad 10）
      padNets[pnum] = Number.isFinite(Number(nn[1]))
        ? Number(nn[1])
        : netIdOf(String(nn[1] ?? ''));
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
  // F.Cu/B.Cu → 'top'/'bottom' 画布别名；其余铜层（In1.Cu 等）保留 KiCad 原名
  const canonLayer = (raw: string): string => {
    const ly = raw.replace(/^"|"$/g, '');
    if (ly === 'F.Cu') return 'top';
    if (ly === 'B.Cu') return 'bottom';
    return ly || 'top';
  };
  const tracks: { x1: number; y1: number; x2: number; y2: number; w: number; layer: string; net?: number }[] = [];
  for (const seg of findAll(pcb, 'segment')) {
    const st = find(seg, 'start'), en = find(seg, 'end'), wd = find(seg, 'width');
    const ly = String(find(seg, 'layer')?.[1] ?? '');
    const nn = find(seg, 'net');
    if (!st || !en) continue;
    const netId = nn ? (Number.isFinite(Number(nn[1])) ? Number(nn[1]) : netIdOf(String(nn[1] ?? ''))) : NaN;
    tracks.push({
      x1: num(st, 1), y1: num(st, 2), x2: num(en, 1), y2: num(en, 2),
      w: wd ? num(wd, 1) : 0.25,
      layer: canonLayer(ly),
      net: Number.isFinite(netId) ? netId : undefined,
    });
  }
  const viasArr: { x: number; y: number; size: number; drill?: number; net?: number; layers?: [string, string]; viaType?: 'blind' | 'micro' }[] = [];
  for (const v of findAll(pcb, 'via')) {
    const at = find(v, 'at'), sz = find(v, 'size'), dr = find(v, 'drill'), nn = find(v, 'net'), lys = find(v, 'layers');
    if (!at) continue;
    const netId = nn ? (Number.isFinite(Number(nn[1])) ? Number(nn[1]) : netIdOf(String(nn[1] ?? ''))) : NaN;
    // (layers "F.Cu" "B.Cu")：贯穿层对原样保留（盲埋孔的层对不同）
    const layerPair = lys
      ? [String(lys[1] ?? '').replace(/^"|"$/g, ''), String(lys[2] ?? '').replace(/^"|"$/g, '')] as [string, string]
      : undefined;
    const viaType = v.some((tok) => tok === 'blind') ? 'blind' as const : v.some((tok) => tok === 'micro') ? 'micro' as const : undefined;
    viasArr.push({
      x: num(at, 1), y: num(at, 2),
      size: sz ? num(sz, 1) : 0.6,
      drill: dr ? num(dr, 1) : undefined,   // 真实钻径；导出时禁止用 size*0.5 重新猜
      net: Number.isFinite(netId) ? netId : undefined,
      layers: layerPair,
      viaType,
    });
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
  // 有 Edge.Cuts 时严格按板框（真实小板可以只有几毫米）；
  // 只有兜底推断模式才套用 20mm 最小值，避免生成过小的画布。
  const rawW = Math.ceil(maxX - ox + pad);
  const rawH = Math.ceil(maxY - oy + pad);
  const widthMm = hasOutline ? Math.max(1, rawW) : Math.max(20, rawW);
  const heightMm = hasOutline ? Math.max(1, rawH) : Math.max(20, rawH);

  return { nets, copperLayers, tracks, vias: viasArr, mountingHoles, widthMm, heightMm, originXMm: hasOutline ? minX : 0, originYMm: hasOutline ? minY : 0, comps, hasMountingHoles, skipped, footprintDefs, modelRefs, projectModelPaths };
}

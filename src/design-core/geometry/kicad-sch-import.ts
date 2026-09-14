/**
 * KiCad 原理图（.kicad_sch）解析 —— 服务于工程 zip 导入：
 *
 * .kicad_sch 自包含所有用到的符号定义（lib_symbols 区块），无需再访问符号库。
 * 提取两类信息：
 *   1. libSymbols：  libId("Device:LED") → 符号定义原文（喂给 parseKicadSym 注册 override）
 *   2. instances：   原理图器件实例的 位号(Reference) → libId 映射（与 PCB 导入的位号对齐）
 *
 * 用平衡括号文本扫描而非全量 S 表达式解析：sch 文件可达数 MB，只取所需区块更稳更快。
 */

export interface SchInstance {
  ref: string; libId: string; value?: string;
  x: number; y: number; rot: number; mirror?: string; unit?: number;
  mat?: [number, number, number, number];
  /** 位号标注的绝对坐标与朝向（KiCad 中用户可拖动，必须原样还原，否则会压到连线上） */
  refPos?: { x: number; y: number; rot: number; hidden: boolean };
  /** 值标注的绝对坐标与朝向 */
  valPos?: { x: number; y: number; rot: number; hidden: boolean };
}

export interface KicadSchResult {
  /** libId → 符号定义块原文（顶层 (symbol "Lib:Name" …)） */
  libSymbols: Record<string, string>;
  /** 器件实例：位号 → libId（跳过电源符号 #PWR / power:*，用于符号挂载） */
  refToLibId: Record<string, string>;
  /** 全部实例（含电源符号，用于原样渲染） */
  instances: SchInstance[];
  /** 连线段（mm 坐标折线） */
  wires: [number, number][][];
  /** 总线与总线入口 */
  buses: [number, number][][];
  busEntries: [number, number][][];
  /** 图纸尺寸与标题栏 */
  frame?: { wMm: number; hMm: number; title?: string; date?: string; rev?: string; company?: string; comments?: string[] };
  junctions: [number, number][];
  labels: { text: string; x: number; y: number; rot: number; kind?: 'local' | 'global' | 'hierarchical'; shape?: string }[];
  /** 本页里的层级页框（父页视角）：点开可进入子页 */
  sheets: { name: string; file: string; x: number; y: number; w: number; h: number; pins: { name: string; x: number; y: number; rot: number; shape?: string }[] }[];
  noConnects: [number, number][];
}

/** 从 idx 处（指向 '('）提取平衡括号块 */
function balancedBlock(text: string, idx: number): string | null {
  let depth = 0;
  for (let j = idx; j < text.length; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')') { depth--; if (depth === 0) return text.slice(idx, j + 1); }
  }
  return null;
}

export function parseKicadSch(text: string): KicadSchResult {
  const libSymbols: Record<string, string> = {};
  const refToLibId: Record<string, string> = {};
  const instances: SchInstance[] = [];
  const wires: [number, number][][] = [];
  const buses: [number, number][][] = [];
  const busEntries: [number, number][][] = [];
  const junctions: [number, number][] = [];
  const labels: KicadSchResult['labels'] = [];
  const sheets: KicadSchResult['sheets'] = [];
  const noConnects: [number, number][] = [];

  // ── 1. lib_symbols 区块内的符号定义 ──
  const libIdx = text.indexOf('(lib_symbols');
  if (libIdx >= 0) {
    const libBlock = balancedBlock(text, libIdx);
    if (libBlock) {
      // 区块内逐个顶层 (symbol "Lib:Name" …)
      let pos = '(lib_symbols'.length;
      while (pos < libBlock.length) {
        const i = libBlock.indexOf('(symbol "', pos);
        if (i < 0) break;
        const block = balancedBlock(libBlock, i);
        if (!block) break;
        const m = block.match(/^\(symbol "([^"]+)"/);
        if (m) libSymbols[m[1]] = block;
        pos = i + block.length;
      }
    }
  }

  // ── 2. 器件实例：(symbol (lib_id "X") … (property "Reference" "D22") ──
  // 全文扫描（不依赖 lib_symbols 块配平）；定义块特征是 '(symbol "'，实例块是 '(symbol (' 
  let pos = 0;
  while (pos < text.length) {
    const i = text.indexOf('(symbol', pos);
    if (i < 0) break;
    // 跳过定义式（(symbol "…"）
    const after = text.slice(i + 7, i + 12);
    if (/^\s*"/.test(after)) { pos = i + 7; continue; }
    const block = balancedBlock(text, i);
    if (!block) break;
    const lid = block.match(/\(lib_id\s+"([^"]+)"/)?.[1];
    const ref = block.match(/\(property\s+"Reference"\s+"([^"]+)"/)?.[1];
    /** 取某个 property 的文本 + 标注位置（KiCad6：(property "X" "v" (at x y rot) … (effects … hide))） */
    const propOf = (nameRe: string) => {
      const m = block.match(new RegExp(`\\(property\\s+"${nameRe}"\\s+"((?:[^"\\\\]|\\\\.)*)"([\\s\\S]{0,400}?)\\)\\s*(?=\\(property|$)`));
      if (!m) return undefined;
      const at2 = m[2].match(/\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)/);
      return {
        text: m[1],
        pos: at2 ? {
          x: parseFloat(at2[1]), y: parseFloat(at2[2]), rot: at2[3] ? parseFloat(at2[3]) : 0,
          hidden: /\bhide\b/.test(m[2]),
        } : undefined,
      };
    };
    if (lid && ref) {
      const at = block.match(/\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)/);
      const mirror = block.match(/\(mirror\s+([xy])\)/)?.[1];
      const unit = block.match(/\(unit\s+(\d+)\)/)?.[1];
      if (at) {
        const refProp = propOf('Reference');
        const valProp = propOf('Value');
        instances.push({
          ref, libId: lid, value: valProp?.text,
          x: parseFloat(at[1]), y: parseFloat(at[2]), rot: at[3] ? parseFloat(at[3]) : 0,
          mirror, unit: unit ? parseInt(unit, 10) : undefined,
          refPos: refProp?.pos, valPos: valProp?.pos,
        });
      }
      if (!ref.startsWith('#') && !lid.startsWith('power:')) refToLibId[ref] = lid;
    }
    pos = i + block.length;
  }

  // ── 3. 连线 / 结点 / 标签 / no_connect ──
  for (const m of text.matchAll(/\(wire\s*\(pts\s*((?:\(xy\s+[-\d.]+\s+[-\d.]+\)\s*)+)\)/g)) {
    const pts = [...m[1].matchAll(/\(xy\s+([-\d.]+)\s+([-\d.]+)\)/g)].map((q) => [parseFloat(q[1]), parseFloat(q[2])] as [number, number]);
    if (pts.length >= 2) wires.push(pts);
  }
  // 总线（bus）与总线入口（bus_entry）：KiCad 6+ 与 wire 同构
  for (const m of text.matchAll(/\(bus\s*\(pts\s*((?:\(xy\s+[-\d.]+\s+[-\d.]+\)\s*)+)\)/g)) {
    const pts = [...m[1].matchAll(/\(xy\s+([-\d.]+)\s+([-\d.]+)\)/g)].map((q) => [parseFloat(q[1]), parseFloat(q[2])] as [number, number]);
    if (pts.length >= 2) buses.push(pts);
  }
  for (const m of text.matchAll(/\(bus_entry\s*\(at\s+([-\d.]+)\s+([-\d.]+)\)\s*\(size\s+([-\d.]+)\s+([-\d.]+)\)/g)) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]);
    busEntries.push([[x, y], [x + parseFloat(m[3]), y + parseFloat(m[4])]]);
  }
  for (const m of text.matchAll(/\(junction\s*\(at\s+([-\d.]+)\s+([-\d.]+)\)/g)) junctions.push([parseFloat(m[1]), parseFloat(m[2])]);
  // 本地标签 / 全局标签 / 层级标签都要画：层级标签就是子页与父页对接的"管脚"，
  // 此前只抓 (global_)?label，子页里 hierarchical_label 一个都不显示
  for (const m of text.matchAll(/\((local_|global_|hierarchical_)?label\s+"((?:[^"\\]|\\.)*)"\s*(?:\(shape\s+([a-z_]+)\)\s*)?\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)/g)) {
    const kindRaw = m[1] ?? '';
    labels.push({
      text: m[2], x: parseFloat(m[4]), y: parseFloat(m[5]), rot: m[6] ? parseFloat(m[6]) : 0,
      kind: kindRaw === 'global_' ? 'global' : kindRaw === 'hierarchical_' ? 'hierarchical' : 'local',
      shape: m[3],
    });
  }
  // 层级页框：(sheet (at x y) (size w h) … (property "Sheetname" …) (property "Sheetfile" …) (pin "NAME" input (at x y rot)…))
  for (const m of text.matchAll(/\(sheet\s*\n?\s*\(at\s+([-\d.]+)\s+([-\d.]+)\)\s*\(size\s+([-\d.]+)\s+([-\d.]+)\)/g)) {
    const block = balancedBlock(text, m.index!);
    if (!block) continue;
    const name = block.match(/\(property\s+"Sheetname"\s+"((?:[^"\\]|\\.)*)"/)?.[1] ?? '';
    const file = block.match(/\(property\s+"Sheetfile"\s+"((?:[^"\\]|\\.)*)"/)?.[1] ?? '';
    const pins: { name: string; x: number; y: number; rot: number; shape?: string }[] = [];
    for (const pm of block.matchAll(/\(pin\s+"((?:[^"\\]|\\.)*)"\s+([a-z_]+)\s*\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)/g)) {
      pins.push({ name: pm[1], shape: pm[2], x: parseFloat(pm[3]), y: parseFloat(pm[4]), rot: pm[5] ? parseFloat(pm[5]) : 0 });
    }
    sheets.push({ name, file, x: parseFloat(m[1]), y: parseFloat(m[2]), w: parseFloat(m[3]), h: parseFloat(m[4]), pins });
  }
  for (const m of text.matchAll(/\(no_connect\s*\(at\s+([-\d.]+)\s+([-\d.]+)\)/g)) noConnects.push([parseFloat(m[1]), parseFloat(m[2])]);

  // ── 图纸尺寸与标题栏 ──
  const PAPER: Record<string, [number, number]> = {
    A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
    A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
  };
  const paperM = text.match(/\(paper\s+"([^"]+)"(?:\s+([-\d.]+)\s+([-\d.]+))?/);
  let frame: KicadSchResult['frame'];
  if (paperM) {
    const named = PAPER[paperM[1].toUpperCase()];
    const wMm = paperM[2] ? parseFloat(paperM[2]) : (named?.[0] ?? 297);
    const hMm = paperM[3] ? parseFloat(paperM[3]) : (named?.[1] ?? 210);
    const portrait = /portrait/i.test(paperM[0]);
    frame = { wMm: portrait ? Math.min(wMm, hMm) : wMm, hMm: portrait ? Math.max(wMm, hMm) : hMm, comments: [] };
    const tb = text.match(/\(title_block([\s\S]*?)\n\s*\)/);
    if (tb) {
      frame.title = tb[1].match(/\(title\s+"((?:[^"\\]|\\.)*)"/)?.[1];
      frame.date = tb[1].match(/\(date\s+"((?:[^"\\]|\\.)*)"/)?.[1];
      frame.rev = tb[1].match(/\(rev\s+"((?:[^"\\]|\\.)*)"/)?.[1];
      frame.company = tb[1].match(/\(company\s+"((?:[^"\\]|\\.)*)"/)?.[1];
      for (const cm of tb[1].matchAll(/\(comment\s+\d+\s+"((?:[^"\\]|\\.)*)"/g)) {
        if (cm[1]) frame.comments!.push(cm[1]);
      }
    }
  }

  return { libSymbols, refToLibId, instances, wires, buses, busEntries, frame, junctions, labels, noConnects, sheets };
}

/** 符号定义块 → 原始 mm 几何（原点保持，供原理图原样渲染做实例变换） */
export interface RawSymGeom {
  polys: { x: number; y: number }[][];
  rects: { x1: number; y1: number; x2: number; y2: number }[];
  circles: { cx: number; cy: number; r: number }[];
  arcs: { x1: number; y1: number; xm: number; ym: number; x2: number; y2: number }[];
  pins: { x: number; y: number; ex: number; ey: number; number: string; name?: string }[];
}

const rawGeomCache = new Map<string, RawSymGeom>();

export function rawSymbolGeom(block: string): RawSymGeom {
  const hit = rawGeomCache.get(block);
  if (hit) return hit;
  const g: RawSymGeom = { polys: [], rects: [], circles: [], arcs: [], pins: [] };
  const nums = (mm: RegExpMatchArray, a: number, b: number): [number, number] => [parseFloat(mm[a]), parseFloat(mm[b])];
  for (const m of block.matchAll(/\(polyline\s*\(pts\s*((?:\(xy\s+[-\d.]+\s+[-\d.]+\)\s*)+)\)/g)) {
    const pts = [...m[1].matchAll(/\(xy\s+([-\d.]+)\s+([-\d.]+)\)/g)].map((q) => ({ x: parseFloat(q[1]), y: parseFloat(q[2]) }));
    if (pts.length >= 2) g.polys.push(pts);
  }
  for (const m of block.matchAll(/\(rectangle\s*\(start\s+([-\d.]+)\s+([-\d.]+)\)\s*\(end\s+([-\d.]+)\s+([-\d.]+)\)/g)) {
    const [x1, y1] = nums(m, 1, 2), [x2, y2] = nums(m, 3, 4);
    g.rects.push({ x1, y1, x2, y2 });
  }
  for (const m of block.matchAll(/\(circle\s*\(center\s+([-\d.]+)\s+([-\d.]+)\)\s*\(radius\s+([-\d.]+)\)/g)) {
    g.circles.push({ cx: parseFloat(m[1]), cy: parseFloat(m[2]), r: parseFloat(m[3]) });
  }
  for (const m of block.matchAll(/\(arc\s*\(start\s+([-\d.]+)\s+([-\d.]+)\)\s*\(mid\s+([-\d.]+)\s+([-\d.]+)\)\s*\(end\s+([-\d.]+)\s+([-\d.]+)\)/g)) {
    const [x1, y1] = nums(m, 1, 2), [xm, ym] = nums(m, 3, 4), [x2, y2] = nums(m, 5, 6);
    g.arcs.push({ x1, y1, xm, ym, x2, y2 });
  }
  // (pin passive line (at x y ang) (length L) (name "VDD" …) (number "1" …))
  for (const m of block.matchAll(/\(pin\s+\w+\s+\w+\s*\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)\s*\(length\s+([-\d.]+)\)([\s\S]{0,400}?)\(number\s+"([^"]*)"/g)) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]), ang = m[3] ? parseFloat(m[3]) : 0, len = parseFloat(m[4]);
    const rad = (ang * Math.PI) / 180;
    const nm = m[5].match(/\(name\s+"([^"]*)"/)?.[1];
    g.pins.push({
      x, y, ex: x + Math.cos(rad) * len, ey: y + Math.sin(rad) * len,
      number: m[6],
      name: nm && nm !== '~' ? nm : undefined,   // ~ 表示无名
    });
  }
  rawGeomCache.set(block, g);
  return g;
}

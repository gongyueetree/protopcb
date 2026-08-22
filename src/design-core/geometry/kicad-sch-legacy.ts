/**
 * KiCad 5 旧版原理图（.sch, EESchema Schematic File Version 4）解析器。
 *
 * 与 KiCad 6+ 的 S 表达式格式完全不同：这是行式文本格式。
 *   $Comp … $EndComp   器件实例（L 库:符号 位号 / U 单元 / P 坐标 / F n "值" / 方向矩阵）
 *   Wire Wire Line     连线（下一行是四个坐标）
 *   Connection ~ x y   结点
 *   Text Label x y …   网络标签（下一行是文本）
 *   NoConn ~ x y       未连接标记
 *
 * 坐标单位是 mil（1/1000 英寸），需换算为 mm：mm = mil * 0.0254
 *
 * 老工程（2020 年前）大量使用此格式，SimpleDDS_DAP 即为实例。
 */

const MIL_TO_MM = 0.0254;

export interface LegacySchComp {
  ref: string;
  value: string;
  libId: string;
  footprint?: string;
  x: number; y: number;      // mm
  unit: number;
  /** 方向矩阵（KiCad 5 用 2x2 矩阵表示旋转/镜像）→ 归一化角度 */
  rot: number;
  mirror?: 'x' | 'y';
}

export interface SheetInfo {
  wMm: number; hMm: number;
  title?: string; date?: string; rev?: string; company?: string; comments?: string[];
}

export interface LegacySchResult {
  sheet?: SheetInfo;
  comps: LegacySchComp[];
  wires: [number, number][][];
  junctions: [number, number][];
  labels: { text: string; x: number; y: number; rot: number }[];
  noConnects: [number, number][];
  /** 位号 → 封装名（用于与 PCB 对齐） */
  refToFootprint: Record<string, string>;
}

/** KiCad 5 方向矩阵 → 角度/镜像。矩阵 (a b c d) 作用于 (x,y) */
function matrixToTransform(a: number, b: number, c: number, d: number): { rot: number; mirror?: 'x' | 'y' } {
  // 常见组合（KiCad 5 EESchema 约定，Y 轴向下）
  if (a === 1 && b === 0 && c === 0 && d === -1) return { rot: 0 };
  if (a === 0 && b === -1 && c === -1 && d === 0) return { rot: 90 };
  if (a === -1 && b === 0 && c === 0 && d === 1) return { rot: 180 };
  if (a === 0 && b === 1 && c === 1 && d === 0) return { rot: 270 };
  if (a === -1 && b === 0 && c === 0 && d === -1) return { rot: 0, mirror: 'y' };
  if (a === 1 && b === 0 && c === 0 && d === 1) return { rot: 0, mirror: 'x' };
  if (a === 0 && b === 1 && c === -1 && d === 0) return { rot: 90, mirror: 'x' };
  if (a === 0 && b === -1 && c === 1 && d === 0) return { rot: 270, mirror: 'x' };
  return { rot: 0 };
}

export function parseLegacySch(text: string): LegacySchResult {
  const comps: LegacySchComp[] = [];
  const wires: [number, number][][] = [];
  const junctions: [number, number][] = [];
  const labels: { text: string; x: number; y: number; rot: number }[] = [];
  const noConnects: [number, number][] = [];
  const refToFootprint: Record<string, string> = {};
  let sheet: SheetInfo | undefined;

  const lines = text.split(/\r?\n/);
  const mm = (mil: number) => +(mil * MIL_TO_MM).toFixed(3);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── 图框与标题栏：$Descr A4 11693 8268 后跟 Title/Date/Rev/Comp/CommentN ──
    if (line.startsWith('$Descr')) {
      const md = line.match(/^\$Descr\s+\S+\s+(\d+)\s+(\d+)/);
      sheet = { wMm: md ? mm(+md[1]) : 297, hMm: md ? mm(+md[2]) : 210, comments: [] };
      for (i++; i < lines.length && !lines[i].startsWith('$EndDescr'); i++) {
        const l = lines[i];
        const tv = (k: string) => l.match(new RegExp(`^${k}\\s+"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
        const t2 = tv('Title'); if (t2) sheet.title = t2;
        const d2 = tv('Date'); if (d2) sheet.date = d2;
        const r2 = tv('Rev'); if (r2) sheet.rev = r2;
        const c2 = tv('Comp'); if (c2) sheet.company = c2;
        const cm = l.match(/^Comment\d+\s+"((?:[^"\\]|\\.)*)"/)?.[1];
        if (cm) sheet.comments!.push(cm);
      }
      continue;
    }

    // ── 器件实例 ──
    if (line.startsWith('$Comp')) {
      let ref = '', value = '', libId = '', footprint = '';
      let x = 0, y = 0, unit = 1, rot = 0;
      let mirror: 'x' | 'y' | undefined;
      for (i++; i < lines.length && !lines[i].startsWith('$EndComp'); i++) {
        const l = lines[i];
        // L 库:符号名 位号
        const mL = l.match(/^L\s+(\S+)\s+(\S+)/);
        if (mL) { libId = mL[1]; ref = mL[2]; continue; }
        // U 单元 变体 时间戳
        const mU = l.match(/^U\s+(\d+)/);
        if (mU) { unit = parseInt(mU[1], 10) || 1; continue; }
        // P x y（mil）
        const mP = l.match(/^P\s+(-?\d+)\s+(-?\d+)/);
        if (mP) { x = mm(parseInt(mP[1], 10)); y = mm(parseInt(mP[2], 10)); continue; }
        // F 0 "位号" / F 1 "值" / F 2 "封装"
        const mF = l.match(/^F\s+(\d+)\s+"((?:[^"\\]|\\.)*)"/);
        if (mF) {
          const idx = parseInt(mF[1], 10);
          const val = mF[2];
          if (idx === 0 && val) ref = val;   // F 0 为权威位号（L 行可能是未标注的 R?）
          else if (idx === 1) value = val;
          else if (idx === 2 && val) footprint = val.includes(':') ? val.split(':').pop()! : val;
          continue;
        }
        // 方向矩阵行：以 tab 开头的四个整数
        const mM = l.match(/^\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/);
        if (mM) {
          const t = matrixToTransform(+mM[1], +mM[2], +mM[3], +mM[4]);
          rot = t.rot; mirror = t.mirror;
          continue;
        }
      }
      if (ref && !ref.startsWith('#')) {
        comps.push({ ref, value, libId, footprint: footprint || undefined, x, y, unit, rot, mirror });
        if (footprint) refToFootprint[ref] = footprint;
      }
      continue;
    }

    // ── 连线：Wire Wire Line 后跟坐标行 ──
    if (/^Wire\s+Wire\s+Line/.test(line)) {
      const nxt = lines[i + 1] ?? '';
      const m = nxt.match(/(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
      if (m) {
        wires.push([[mm(+m[1]), mm(+m[2])], [mm(+m[3]), mm(+m[4])]]);
        i++;
      }
      continue;
    }

    // ── 结点 ──
    const mConn = line.match(/^Connection\s+~\s+(-?\d+)\s+(-?\d+)/);
    if (mConn) { junctions.push([mm(+mConn[1]), mm(+mConn[2])]); continue; }

    // ── 未连接标记 ──
    const mNC = line.match(/^NoConn\s+~\s+(-?\d+)\s+(-?\d+)/);
    if (mNC) { noConnects.push([mm(+mNC[1]), mm(+mNC[2])]); continue; }

    // ── 网络标签：Text Label/GLabel/HLabel x y 方向 尺寸 …，下一行是文本 ──
    const mLbl = line.match(/^Text\s+(Label|GLabel|HLabel|Notes)\s+(-?\d+)\s+(-?\d+)\s+(\d+)/);
    if (mLbl && mLbl[1] !== 'Notes') {
      const txt = (lines[i + 1] ?? '').trim();
      if (txt) {
        labels.push({ text: txt, x: mm(+mLbl[2]), y: mm(+mLbl[3]), rot: (+mLbl[4] % 4) * 90 });
        i++;
      }
      continue;
    }
  }

  return { sheet, comps, wires, junctions, labels, noConnects, refToFootprint };
}

/** 是否为 KiCad 5 旧版原理图文本 */
export function isLegacySch(text: string): boolean {
  return /^EESchema Schematic File Version [0-9]/m.test(text.slice(0, 500));
}

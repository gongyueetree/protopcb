/**
 * design-core/geometry/altium-sch-import.ts
 * Altium `.SchDoc` → `KicadSchResult`（与 KiCad 原理图导入同一个结构）。
 *
 * AD 的原理图整份在一个 `FileHeader` 流里，是一串长度前缀的属性记录，靠 `OWNERINDEX`
 * 组成树：RECORD=1 是器件，它的子记录里 RECORD=2 是管脚、6/7/12/13/14 是图形、
 * 34/41 是参数与标注；顶层还有 27（连线）、29（结点）、25/17（网络标签/电源端口）。
 *
 * 符号几何按**器件**聚合成 ParsedSymbol 注册进符号注册表，实例只带位置与旋转 ——
 * 与 KiCad 路径完全一致，因此原理图页面、符号预览、导出都不用改。
 *
 * 单位：AD 原理图坐标是 1/10 mil（内部单位），乘 0.254 得毫米。
 */
import { openAltiumFile, readPropsSection, type AltiumProps } from './altium-records';
import type { KicadSchResult, SchInstance } from './kicad-sch-import';
import type { ParsedSymbol } from './lib-file-registry';

/** AD 原理图内部单位 → mm */
const SCH_UNIT = 0.254;

const numOf = (p: AltiumProps, k: string) => {
  const n = Number.parseFloat(p[k] ?? '0');
  return Number.isFinite(n) ? n : 0;
};
/** 带小数部分的坐标：AD 把小数放在 <KEY>_FRAC 里（1/100000） */
const coord = (p: AltiumProps, k: string) => (numOf(p, k) + numOf(p, `${k}_FRAC`) / 100000) * SCH_UNIT;

export interface AltiumSchOptions {
  onWarning?: (message: string) => void;
}

export interface AltiumSchResult extends KicadSchResult {
  /** 器件位号 → 该器件的符号几何（注册进符号注册表用） */
  symbolsByRef: Record<string, ParsedSymbol>;
}

/**
 * 解析 .SchDoc。
 * @throws 不是有效 AD 原理图（无可识别记录）时
 */
export function parseAltiumSch(bytes: Uint8Array, opts: AltiumSchOptions = {}): AltiumSchResult {
  const stream = openAltiumFile(bytes);
  /**
   * ⚠ 首条是图纸头记录，不参与 OWNERINDEX 编号 —— 去掉它之后下标才与 OWNERINDEX 对齐。
   * 不去会整体错位 1，表现为"所有管脚都找不到属主"，器件解析出 0 个。
   */
  const all = readPropsSection(stream, 'FileHeader');
  if (!all.length) throw new Error('不是有效的 Altium 原理图文件（FileHeader 段为空）');
  const records = all.slice(1);
  const warn = (m: string) => opts.onWarning?.(m);

  /* ── 器件实例（RECORD=1）── */
  interface CompDraft {
    index: number;
    ref: string;
    value: string;
    libRef: string;
    x: number; y: number;
    rot: number;
    unit: number;
    /** 当前显示样式：AD 的器件可以有多套画法（DISPLAYMODECOUNT），只画选中的那套 */
    displayMode: number;
    /** 该器件的图形与管脚，先按绝对坐标收集，最后转成以器件原点为中心的局部坐标 */
    rects: { x: number; y: number; w: number; h: number }[];
    polys: string[];
    circles: { x: number; y: number; r: number }[];
    pins: ParsedSymbol['pins'];
  }
  const drafts = new Map<number, CompDraft>();

  records.forEach((r, index) => {
    if (r.RECORD !== '1') return;
    // 子记录里的参数（34=位号 41=参数）给出位号与值
    const children = records.filter((c) => c.OWNERINDEX === String(index));
    const fields: Record<string, string> = {};
    for (const c of children) {
      if ((c.RECORD === '34' || c.RECORD === '41') && c.NAME) fields[c.NAME] = c.TEXT ?? '';
    }
    drafts.set(index, {
      index,
      ref: fields.Designator || `X${index}`,
      value: fields.Comment || r.LIBREFERENCE || '',
      libRef: r.LIBREFERENCE || r.DESIGNITEMID || 'Unknown',
      x: coord(r, 'LOCATION.X'),
      y: -coord(r, 'LOCATION.Y'),                 // AD 的 Y 向上，画布向下
      // ORIENTATION 是 0..3 的象限数（每档 90°）
      rot: (numOf(r, 'ORIENTATION') % 4) * 90,
      unit: numOf(r, 'CURRENTPARTID') || 1,
      displayMode: numOf(r, 'DISPLAYMODE'),
      rects: [], polys: [], circles: [], pins: [],
    });
  });

  if (!drafts.size) warn('未在原理图中找到器件记录');

  /* ── 图形与管脚：按 OWNERINDEX 归到器件；顶层的连线/标签单独收 ── */
  const wires: [number, number][][] = [];
  const junctions: [number, number][] = [];
  const labels: KicadSchResult['labels'] = [];
  const noConnects: [number, number][] = [];
  let unsupported = 0;

  const pointList = (r: AltiumProps): [number, number][] => {
    const n = Math.min(numOf(r, 'LOCATIONCOUNT'), 5000);
    const out: [number, number][] = [];
    for (let i = 1; i <= n; i++) out.push([coord(r, `X${i}`), -coord(r, `Y${i}`)]);
    return out;
  };

  records.forEach((r, index) => {
    const type = r.RECORD ?? '';
    const owner = drafts.get(numOf(r, 'OWNERINDEX'));
    const x = coord(r, 'LOCATION.X');
    const y = -coord(r, 'LOCATION.Y');

    /**
     * 只画"当前单元 + 当前显示样式"。
     * 多单元（双运放）看 OWNERPARTID，多画法（电阻的 3 套样式）看 OWNERPARTDISPLAYMODE。
     * 不过滤 displayMode 的后果：一个 2 脚电阻会画出 6 个管脚、3 层图形叠在一起。
     */
    if (owner) {
      if (numOf(r, 'OWNERPARTID') > 0 && numOf(r, 'OWNERPARTID') !== owner.unit) return;
      if (r.OWNERPARTDISPLAYMODE !== undefined && numOf(r, 'OWNERPARTDISPLAYMODE') !== owner.displayMode) return;
    }

    if (type === '2' && owner) {
      /* 管脚：PINCONGLOMERATE 低 2 位是朝向象限，bit2 是隐藏位 */
      const cong = numOf(r, 'PINCONGLOMERATE');
      const angle = (cong & 3) * (Math.PI / 2);
      const len = coord(r, 'PINLENGTH');
      owner.pins.push({
        // tip 是连接点（导线接的那端），end 是符号本体那端
        tipX: x + len * Math.cos(angle),
        tipY: y - len * Math.sin(angle),
        endX: x, endY: y,
        name: r.NAME ?? '',
        number: r.DESIGNATOR ?? '',
        nameX: x, nameY: y,
        numX: x, numY: y,
      });
    } else if (owner && (type === '6' || type === '7')) {
      const pts = pointList(r);
      if (pts.length >= 2) owner.polys.push(toPath(pts, type === '7'));
    } else if (owner && type === '13') {
      owner.polys.push(toPath([[x, y], [coord(r, 'CORNER.X'), -coord(r, 'CORNER.Y')]], false));
    } else if (owner && type === '14') {
      const cx = coord(r, 'CORNER.X'), cy = -coord(r, 'CORNER.Y');
      owner.rects.push({ x: Math.min(x, cx), y: Math.min(y, cy), w: Math.abs(cx - x), h: Math.abs(cy - y) });
    } else if (owner && (type === '8' || type === '12')) {
      const rr = coord(r, 'RADIUS');
      if (type === '12' && !r.ENDANGLE) owner.circles.push({ x, y, r: rr });
      else owner.polys.push(toPath(arcPoints(x, y, rr, numOf(r, 'STARTANGLE'), r.ENDANGLE ? numOf(r, 'ENDANGLE') : 360), false));
    } else if (type === '27') {
      const pts = pointList(r);
      if (pts.length >= 2) wires.push(pts);
    } else if (type === '29') {
      junctions.push([x, y]);
    } else if (type === '25' || type === '17') {
      // 25 = 网络标签，17 = 电源端口
      labels.push({
        text: r.TEXT ?? r.NAME ?? '',
        x, y,
        rot: (numOf(r, 'ORIENTATION') % 4) * 90,
        kind: type === '17' ? 'global' : 'local',
      });
    } else if (type === '22') {
      noConnects.push([x, y]);
    } else if (['15', '16', '18'].includes(type)) {
      unsupported++;    // 图纸符号/端口/线束：本轮不画
    }
    void index;
  });

  if (unsupported) warn(`${unsupported} 个图纸符号/端口未绘制（层级图纸本轮不支持）`);

  /* ── 器件几何转局部坐标 + 产出实例 ── */
  const instances: SchInstance[] = [];
  const refToLibId: Record<string, string> = {};
  const symbolsByRef: Record<string, ParsedSymbol> = {};

  for (const d of drafts.values()) {
    const shift = <T extends { x: number; y: number }>(o: T): T => ({ ...o, x: o.x - d.x, y: o.y - d.y });
    const sym: ParsedSymbol = {
      w: 0, h: 0,
      rects: d.rects.map(shift),
      polys: d.polys.map((p) => translatePath(p, -d.x, -d.y)),
      circles: d.circles.map(shift),
      pins: d.pins.map((p) => ({
        ...p,
        tipX: p.tipX - d.x, tipY: p.tipY - d.y,
        endX: p.endX - d.x, endY: p.endY - d.y,
        nameX: p.nameX - d.x, nameY: p.nameY - d.y,
        numX: p.numX - d.x, numY: p.numY - d.y,
      })),
    };
    // 包围盒：符号预览按它缩放
    const xs = [...sym.rects.flatMap((r) => [r.x, r.x + r.w]), ...sym.pins.flatMap((p) => [p.tipX, p.endX]), ...sym.circles.map((c) => c.x)];
    const ys = [...sym.rects.flatMap((r) => [r.y, r.y + r.h]), ...sym.pins.flatMap((p) => [p.tipY, p.endY]), ...sym.circles.map((c) => c.y)];
    sym.w = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
    sym.h = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
    if (!sym.pins.length && !sym.rects.length && !sym.polys.length) continue;   // 空符号不注册

    symbolsByRef[d.ref] = sym;
    const libId = `ALTIUM:${d.libRef}`;
    refToLibId[d.ref] = libId;
    instances.push({ ref: d.ref, libId, value: d.value, x: d.x, y: d.y, rot: d.rot, unit: d.unit });
  }

  return {
    libSymbols: {},          // AD 没有 KiCad 那样的符号定义块原文；几何走 symbolsByRef
    refToLibId,
    instances,
    wires,
    buses: [],
    busEntries: [],
    junctions,
    labels,
    sheets: [],
    noConnects,
    symbolsByRef,
  };
}

/** 折线 → SVG path */
function toPath(points: [number, number][], closed: boolean): string {
  if (!points.length) return '';
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(3)},${y.toFixed(3)}`).join(' ');
  return closed ? `${d} Z` : d;
}

/** path 平移（符号几何转局部坐标用） */
function translatePath(d: string, dx: number, dy: number): string {
  return d.replace(/([ML])(-?[\d.]+),(-?[\d.]+)/g, (_m, cmd: string, x: string, y: string) =>
    `${cmd}${(Number(x) + dx).toFixed(3)},${(Number(y) + dy).toFixed(3)}`);
}

/** 圆弧采样成折线 */
function arcPoints(cx: number, cy: number, r: number, startDeg: number, endDeg: number): [number, number][] {
  const sweep = ((endDeg - startDeg) % 360 + 360) % 360 || 360;
  return Array.from({ length: 33 }, (_, i) => {
    const a = ((startDeg + (sweep * i) / 32) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as [number, number];
  });
}

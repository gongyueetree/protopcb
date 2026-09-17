/**
 * design-core/geometry/altium-pcb-import.ts
 * Altium `.PcbDoc` → `KicadImportResult`。
 *
 * 映射到 KiCad 导入的**同一个结构**，后面的 2D 绘制、3D 建模、BOM、KiCad 导出全链路
 * 一行都不用改 —— AD 工程进来之后就是普通的 ProtoPCB 文档。
 *
 * 焊盘的归属方式（方案 A）：AD 的 Pads6 是**板级扁平列表**，每条带 owner 索引指向
 * Components6；这里按 owner 重组成 per-footprint 的 `footprintDefs`，与 KiCad 的
 * 内嵌封装定义同构。同名封装若实例间几何不同，走与 KiCad 相同的冲突检测路径。
 *
 * 坐标系：AD 的 Y 轴向上、原点在板左下；ProtoPCB 与 KiCad 一样 Y 轴向下。
 * 这里统一翻转 Y 并把原点移到板框左上角。
 */
import {
  openAltiumFile, readPropsSection, forEachBinaryRecord,
  fieldReader, shortString, altiumLength, type AltiumProps,
} from './altium-records';
import type { KicadImportResult, KicadImportedComp } from './kicad-pcb-import';
import type { PadFootprint, Pad } from './pad-types';
import {
  readAltiumModelCatalog, readAltiumModelBindings, unpackAltiumModel,
  type AltiumModelCatalogEntry,
} from './altium-models';

/** AD 层号 → 我们的层名（只区分顶/底/内层；其余非铜层不参与走线） */
function copperLayerName(n: number): string | null {
  if (n === 1) return 'F.Cu';
  if (n === 32) return 'B.Cu';
  if (n > 1 && n < 32) return `In${n - 1}.Cu`;
  return null;
}

const numOf = (p: AltiumProps, k: string) => {
  const n = Number.parseFloat(p[k] ?? '0');
  return Number.isFinite(n) ? n : 0;
};

/** 单个焊盘在其所属封装局部坐标里的位置与尺寸 */
interface RawPad {
  ownerIndex: number;
  number: string;
  xMm: number;          // 板级绝对坐标（mm，Y 已翻转）
  yMm: number;
  wMm: number;
  hMm: number;
  holeMm: number;
  shape: number;        // 1=圆/椭圆 2=矩形 其它=圆角矩形
  layer: number;
  netIndex: number;
  rotationDeg: number;
}

/** 解压好的内嵌模型：key 与器件上的 altiumModelKey 对应 */
export interface AltiumEmbeddedModel {
  key: string;
  fileName: string;
  /** STEP 文本字节，可直接交给 step-loader */
  step: Uint8Array;
}

export interface AltiumImportOptions {
  /** 诊断信息回调：解析过程中跳过或近似的内容 */
  onWarning?: (message: string) => void;
}

/**
 * 解析 .PcbDoc。
 * @throws 文件不是有效 AD PCB（缺 Board6）时
 */
export function parseAltiumPcb(bytes: Uint8Array, opts: AltiumImportOptions = {}): KicadImportResult {
  const stream = openAltiumFile(bytes);
  const board = readPropsSection(stream, 'Board6')[0];
  if (!board) throw new Error('不是有效的 Altium PCB 文件（缺少 Board6 段）');

  const warn = (m: string) => opts.onWarning?.(m);

  /* ── 板框：VX/VY 顶点序列，KIND=1 的段是圆弧，按 24 段采样 ── */
  const outline: { x: number; y: number }[] = [];
  for (let n = 0; board[`VX${n}`] !== undefined && n < 10000; n++) {
    outline.push({ x: altiumLength(board[`VX${n}`]), y: -altiumLength(board[`VY${n}`]) });
    if (board[`KIND${n}`] === '1') {
      const start = numOf(board, `SA${n}`);
      const sweep = ((numOf(board, `EA${n}`) - start) % 360 + 360) % 360;
      const cx = altiumLength(board[`CX${n}`]);
      const cy = -altiumLength(board[`CY${n}`]);
      const r = altiumLength(board[`R${n}`]);
      for (let k = 1; k < 24; k++) {
        const t = ((start + (sweep * k) / 24) * Math.PI) / 180;
        outline.push({ x: cx + r * Math.cos(t), y: cy - r * Math.sin(t) });
      }
    }
  }
  if (outline.length < 3) warn('板框顶点不足，板尺寸将按器件包围盒推断');

  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const minX = xs.length ? Math.min(...xs) : 0;
  const minY = ys.length ? Math.min(...ys) : 0;
  const widthMm = xs.length ? Math.max(...xs) - minX : 0;
  const heightMm = ys.length ? Math.max(...ys) - minY : 0;

  /* ── 网络表：索引即编号，与 Pads/Tracks 里的 netIndex 对应 ── */
  const netProps = readPropsSection(stream, 'Nets6');
  const nets: Record<number, string> = {};
  netProps.forEach((p, i) => { nets[i + 1] = p.NAME || `Net${i}`; });   // 0 保留给"无网络"

  /* ── 器件 ── */
  const compProps = readPropsSection(stream, 'Components6');
  const comps: KicadImportedComp[] = [];
  /** 器件的原始 AD 坐标（未减板框原点）：3D Body 的偏移要在同一基准下相减 */
  const rawPositions: { rawXMm: number; rawYMm: number; rotation: number; layer: 'top' | 'bottom' }[] = [];
  const skipped: string[] = [];
  compProps.forEach((p, i) => {
    const reference = p.SOURCEDESIGNATOR || `X${i + 1}`;
    const pattern = p.PATTERN || p.SOURCEFOOTPRINTLIBRARY || 'UNKNOWN';
    if (p.X === undefined || p.Y === undefined) { skipped.push(reference); return; }
    const rotation = ((numOf(p, 'ROTATION') % 360) + 360) % 360;
    const layer: 'top' | 'bottom' = p.LAYER === 'BOTTOM' ? 'bottom' : 'top';
    rawPositions.push({ rawXMm: altiumLength(p.X), rawYMm: altiumLength(p.Y), rotation, layer });
    comps.push({
      reference,
      value: p.SOURCELIBREFERENCE || p.COMMENT || pattern,
      footprintName: pattern,
      xMm: altiumLength(p.X) - minX,
      yMm: -altiumLength(p.Y) - minY,
      // AD 的旋转是逆时针度数，与 KiCad 一致
      rotation,
      layer,
    });
  });

  /* ── 焊盘：扁平列表 → 按 owner 重组 ── */
  const rawPads: RawPad[] = [];
  forEachBinaryRecord(stream('Pads6/Data'), 2, 6, (blocks) => {
    const geo = blocks[4];
    if (!geo || geo.length < 50) return;
    const v = fieldReader(geo);
    rawPads.push({
      ownerIndex: v.u16(7),
      number: shortString(blocks[0]),
      xMm: v.mm(13) - minX,
      yMm: -v.mm(17) - minY,
      wMm: v.mm(21),
      hMm: v.mm(25),
      holeMm: v.mm(45),
      shape: v.byte(49),
      layer: v.byte(0),
      netIndex: v.u16(3),
      rotationDeg: v.f64(52),
    });
  });

  /* ── per-footprint 定义（方案 A）：同名封装取首次出现，冲突单独记录 ── */
  const padsByOwner = new Map<number, RawPad[]>();
  for (const pad of rawPads) {
    const list = padsByOwner.get(pad.ownerIndex);
    if (list) list.push(pad); else padsByOwner.set(pad.ownerIndex, [pad]);
  }

  const footprintDefs: Record<string, PadFootprint> = {};
  const footprintConflicts: { footprintName: string; references: string[]; kept: 'first' }[] = [];
  const padNetsByRef = new Map<string, Record<string, number>>();

  compProps.forEach((p, ownerIndex) => {
    const comp = comps.find((c) => c.reference === (p.SOURCEDESIGNATOR || `X${ownerIndex + 1}`));
    if (!comp) return;
    const own = padsByOwner.get(ownerIndex) ?? [];
    if (!own.length) return;

    // 焊盘转到封装局部坐标：减去器件中心，再按器件旋转反向转回
    const rad = (-comp.rotation * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const local: Pad[] = own.map((pad) => {
      const dx = pad.xMm - comp.xMm;
      const dy = pad.yMm - comp.yMm;
      return {
        num: pad.number || '1',
        x: dx * cos - dy * sin,
        y: dx * sin + dy * cos,
        w: pad.wMm,
        h: pad.hMm,
        round: pad.shape === 1,
      };
    });
    const extent = (sel: (q: Pad) => number, half: (q: Pad) => number) =>
      Math.max(...local.map((q) => Math.abs(sel(q)) + half(q) / 2), 0.5);
    const def: PadFootprint = {
      bodyW: extent((q) => q.x, (q) => q.w) * 2,
      bodyH: extent((q) => q.y, (q) => q.h) * 2,
      pads: local,
    };

    const existing = footprintDefs[comp.footprintName];
    if (!existing) {
      footprintDefs[comp.footprintName] = def;
    } else if (padFingerprint(existing) !== padFingerprint(def)) {
      const c = footprintConflicts.find((x) => x.footprintName === comp.footprintName);
      if (c) { if (!c.references.includes(comp.reference)) c.references.push(comp.reference); }
      else footprintConflicts.push({ footprintName: comp.footprintName, references: [comp.reference], kept: 'first' });
    }

    // 焊盘 → 网络（连接性的唯一依据）
    const map: Record<string, number> = {};
    for (const pad of own) if (pad.netIndex > 0) map[pad.number || '1'] = pad.netIndex;
    if (Object.keys(map).length) padNetsByRef.set(comp.reference, map);
  });

  for (const c of comps) {
    const map = padNetsByRef.get(c.reference);
    if (map) c.padNets = map;
  }

  /* ── 走线与过孔 ── */
  const tracks: KicadImportResult['tracks'] = [];
  const usedLayers = new Set<string>();
  let arcTracks = 0;
  forEachBinaryRecord(stream('Tracks6/Data'), 4, 1, ([b]) => {
    if (!b || b.length < 33) return;
    const v = fieldReader(b);
    const layer = copperLayerName(v.byte(0));
    if (!layer) return;                       // 非铜层的线（丝印/禁布）不进走线
    usedLayers.add(layer);
    tracks.push({
      x1: v.mm(13) - minX, y1: -v.mm(17) - minY,
      x2: v.mm(21) - minX, y2: -v.mm(25) - minY,
      w: v.mm(29),
      layer,
      net: v.u16(3) || undefined,
    });
  });
  // AD 的圆弧走线在 Arcs6 段，本轮不解析
  const arcCount = readPropsSection(stream, 'Arcs6').length;
  if (arcCount) { arcTracks = arcCount; }

  const vias: KicadImportResult['vias'] = [];
  forEachBinaryRecord(stream('Vias6/Data'), 3, 1, ([b]) => {
    if (!b || b.length < 29) return;
    const v = fieldReader(b);
    vias.push({
      x: v.mm(13) - minX, y: -v.mm(17) - minY,
      size: v.mm(21),
      drill: v.mm(25),
      net: v.u16(3) || undefined,
    });
  });

  /* ── 定位孔：无网络的圆形通孔焊盘（AD 里安装孔就是这样画的） ── */
  const mountingHoles: { x: number; y: number; d: number }[] = [];
  for (const pad of rawPads) {
    const isFreePad = !padsByOwner.has(pad.ownerIndex) || pad.ownerIndex >= compProps.length;
    if (pad.holeMm > 0.8 && pad.netIndex === 0 && pad.shape === 1 && isFreePad) {
      mountingHoles.push({ x: pad.xMm, y: pad.yMm, d: pad.holeMm });
    }
  }

  /* ── 内嵌 3D 模型：目录 + 每个实例的绑定与摆正变换 ── */
  const embeddedModels: AltiumEmbeddedModel[] = [];
  try {
    const catalog = readAltiumModelCatalog(stream);
    const bindings = readAltiumModelBindings(stream, rawPositions, catalog, 1.6, warn);
    const used = new Map<string, AltiumModelCatalogEntry>();
    for (const b of bindings) {
      const comp = comps[b.componentIndex];
      if (!comp) continue;
      // 与 KiCad 的 (model) 同构：变换挂在实例上，交给 applyModelTransform 摆正
      comp.modelTransform = b.transform;
      comp.altiumModelKey = b.modelKey;
      const entry = catalog.find((c) => c.key === b.modelKey);
      if (entry) used.set(b.modelKey, entry);
    }
    // 只解压真正被引用的模型（这块板 20 个目录项里实际用到的更少）
    for (const [key, entry] of used) {
      try {
        embeddedModels.push({ key, fileName: entry.fileName, step: unpackAltiumModel(stream(`Models/${entry.streamIndex}`)) });
      } catch (e) {
        warn(`内嵌模型 ${entry.fileName} 解压失败：${String((e as Error).message).slice(0, 80)}`);
      }
    }
  } catch (e) {
    warn(`3D 模型解析失败，PCB 几何不受影响：${String((e as Error).message).slice(0, 100)}`);
  }

  if (arcTracks) warn(`${arcTracks} 段圆弧走线未解析（AD Arcs6），直线走线与连接性不受影响`);
  if (skipped.length) warn(`${skipped.length} 个器件缺少位置信息被跳过：${skipped.slice(0, 5).join('、')}`);

  const copperLayers = ['F.Cu', ...[...usedLayers].filter((l) => l !== 'F.Cu' && l !== 'B.Cu').sort(), 'B.Cu']
    .filter((l) => usedLayers.has(l) || l === 'F.Cu' || l === 'B.Cu');

  return {
    nets,
    copperLayers,
    tracks,
    vias,
    mountingHoles,
    widthMm: Math.max(widthMm, 1),
    heightMm: Math.max(heightMm, 1),
    originXMm: 0,
    originYMm: 0,
    comps,
    hasMountingHoles: mountingHoles.length > 0,
    skipped,
    footprintDefs,
    modelRefs: {},
    projectModelPaths: {},
    footprintConflicts,
    altiumModels: embeddedModels,
  };
}

/** 与 KiCad 导入同一套指纹规则，保证冲突判定一致 */
function padFingerprint(fp: PadFootprint): string {
  return fp.pads
    .map((p) => `${p.num}:${p.x.toFixed(4)},${p.y.toFixed(4)},${p.w.toFixed(4)},${p.h.toFixed(4)}`)
    .sort()
    .join('|');
}

/** 是否是 Altium PCB 文件（按扩展名，内容校验交给 parse） */
export const isAltiumPcbFile = (name: string) => /\.pcbdoc$/i.test(name);
/** 是否是 Altium 原理图文件（本轮不解析，识别出来给出明确提示） */
export const isAltiumSchFile = (name: string) => /\.schdoc$/i.test(name);
/** Altium 工程文件 */
export const isAltiumProjectFile = (name: string) => /\.prjpcb$/i.test(name);

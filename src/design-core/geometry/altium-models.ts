/**
 * design-core/geometry/altium-models.ts
 * Altium `.PcbDoc` 内嵌的 3D 模型。
 *
 * AD 把 STEP 以 zlib 压缩存在 `Models/<n>` 流里，`Models/Data` 是目录（ID → 名称/是否内嵌），
 * `ComponentBodies6` 记录把模型实例绑到器件上，并带各自的偏移与旋转。
 *
 * 这一层输出的是与 `.kicad_pcb` 的 `(model ...)` 同构的信息：每个**实例**一份
 * `{ modelKey, transform }`，交给现有的 `applyModelTransform` 摆正。这样 AD 与 KiCad
 * 两条导入路径在 3D 侧完全共用。
 */
import { Unzlib } from 'fflate';
import { altiumBlocks, altiumProperties, altiumLength, type AltiumProps } from './altium-records';
import type { ModelTransform } from './kicad-pcb-import';

/** 单个模型实例：绑到哪个器件、用哪个模型、怎么摆 */
export interface AltiumModelBinding {
  /** Components6 里的索引（与解析出的 comps 顺序一致） */
  componentIndex: number;
  /** 模型目录键（大写 ID），用于取 `Models/<n>` 的字节 */
  modelKey: string;
  /** 模型文件名，用于显示与扩展名判断 */
  fileName: string;
  /** 与 KiCad `(model)` 同构的摆正变换 */
  transform: ModelTransform;
}

export interface AltiumModelCatalogEntry {
  key: string;
  fileName: string;
  /** 该模型在 CFB 里的流序号（`Models/<index>`） */
  streamIndex: number;
}

const truthy = (s?: string) => s === 'TRUE' || s === 'T';
const upper = (s: string) => s.trim().toUpperCase();
const numOf = (p: AltiumProps, k: string) => {
  const n = Number.parseFloat(p[k] ?? '0');
  return Number.isFinite(n) ? n : 0;
};

/** 单个模型解压后的体积上限：畸形/恶意文件不该撑爆内存 */
const MAX_MODEL_BYTES = 32 * 1024 * 1024;

/** 读模型目录。只返回声明为内嵌且有对应流的条目。 */
export function readAltiumModelCatalog(stream: (n: string) => Uint8Array): AltiumModelCatalogEntry[] {
  const out: AltiumModelCatalogEntry[] = [];
  altiumBlocks(stream('Models/Data')).map(altiumProperties).forEach((p, index) => {
    if (!p.ID || !truthy(p.EMBED)) return;
    if (!stream(`Models/${index}`).length) return;
    out.push({ key: upper(p.ID), fileName: p.NAME || `model${index}.step`, streamIndex: index });
  });
  return out;
}

/**
 * 解压一个内嵌模型（zlib → STEP 文本）。
 * @throws 空模型、超限、或解出来不是 STEP 时
 */
export function unpackAltiumModel(packed: Uint8Array, limit = MAX_MODEL_BYTES): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const unzip = new Unzlib((chunk) => {
    size += chunk.length;
    if (size > limit) throw new Error('AD 内嵌模型展开后超过体积上限');
    chunks.push(chunk);
  });
  for (let i = 0; i < packed.length; i += 65536) {
    unzip.push(packed.subarray(i, i + 65536), i + 65536 >= packed.length);
  }
  if (!size) throw new Error('AD 内嵌模型为空');
  const result = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
  // STEP 文件必须以 ISO-10303-21 开头；不是的话别拿去喂 occt
  if (!new TextDecoder().decode(result.subarray(0, 512)).includes('ISO-10303-21')) {
    throw new Error('AD 内嵌模型不是受支持的 STEP 文件');
  }
  return result;
}

/**
 * 解析 `ComponentBodies6`，把模型实例绑到器件上。
 *
 * 变换推导（与 KiCad 的 Altium 导入器一致）：
 *   - Body 坐标是**板级绝对坐标**，先减去器件位置得到局部偏移
 *   - 底层器件：Y 取反、旋转取反
 *   - `BODYPROJECTION` 与器件所在面不一致时，模型是从另一面看的：绕 X 翻 180°、Z 旋转取反、
 *     并把 Z 偏移压到板厚的另一侧
 *   - 最后按器件旋转把偏移转回局部坐标系
 */
export function readAltiumModelBindings(
  stream: (n: string) => Uint8Array,
  /**
   * 器件的**原始 AD 坐标**（未减板框原点）。Body 的 MODEL.2D.X/Y 也是原始绝对坐标，
   * 两者必须在同一基准下相减才能得到局部偏移 —— 传入已平移过的坐标会得到几十毫米的错位。
   */
  components: { rawXMm: number; rawYMm: number; rotation: number; layer: 'top' | 'bottom' }[],
  catalog: AltiumModelCatalogEntry[],
  boardThicknessMm = 1.6,
  onSkip?: (reason: string) => void,
): AltiumModelBinding[] {
  const byKey = new Map(catalog.map((c) => [c.key, c]));
  const bytes = stream('ComponentBodies6/Data');
  if (!bytes.length) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: AltiumModelBinding[] = [];
  let offset = 0;
  let skipped = 0;

  while (offset < bytes.length) {
    if (offset + 5 > bytes.length || bytes[offset] !== 12) break;   // 记录类型 12；遇到别的就停
    offset += 1;
    const length = view.getUint32(offset, true) & 0xffffff;
    offset += 4;
    if (length < 22 || offset + length > bytes.length) break;
    const componentIndex = view.getUint16(offset + 7, true);
    const propsLength = view.getUint32(offset + 18, true) & 0xffffff;
    if (propsLength > length - 22) { offset += length; skipped++; continue; }
    const p = altiumProperties(bytes.subarray(offset + 22, offset + 22 + propsLength));
    offset += length;

    const comp = components[componentIndex];
    const model = byKey.get(upper(p.MODELID ?? ''));
    if (!comp || !model || !truthy(p['MODEL.EMBED'])) { skipped++; continue; }

    const bottom = comp.layer === 'bottom';
    let dx = altiumLength(p['MODEL.2D.X']) - comp.rawXMm;
    let dy = altiumLength(p['MODEL.2D.Y']) - comp.rawYMm;
    let dz = altiumLength(p['MODEL.3D.DZ']);
    let rx = numOf(p, 'MODEL.3D.ROTX');
    let rz = numOf(p, 'MODEL.3D.ROTZ');
    const ry = numOf(p, 'MODEL.3D.ROTY');
    const angle = comp.rotation * (bottom ? -1 : 1);

    if (bottom) dy = -dy;
    if ((p.BODYPROJECTION === '1') !== bottom) {
      rx += 180;
      rz = -rz;
      dz = -boardThicknessMm - dz;
    }
    const rad = (-angle * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    [dx, dy] = [dx * cos - dy * sin, dx * sin + dy * cos];

    const rotate: [number, number, number] = [-rx, -ry, -rz + numOf(p, 'MODEL.2D.ROTATION') + angle];
    const offsetXyz: [number, number, number] = [dx, dy, dz];
    if (![...offsetXyz, ...rotate].every(Number.isFinite)) { skipped++; continue; }
    /**
     * 偏移合理性检查：局部偏移应在器件尺度内。超出 100mm 说明这条 Body 的
     * MODEL.2D.X/Y 不是以封装原点为基准（AD 允许模型原点画在别处），
     * 硬套会把模型甩到板外 —— 宁可丢掉这一个模型，也不要画错位置。
     */
    if (Math.hypot(dx, dy) > 100) {
      skipped++;
      onSkip?.(`${p.MODELID ? model.fileName : '未命名模型'} 的定位基准异常（偏移 ${Math.hypot(dx, dy).toFixed(0)}mm），已跳过该实例的 3D 模型`);
      continue;
    }

    out.push({
      componentIndex,
      modelKey: model.key,
      fileName: model.fileName,
      transform: { offset: offsetXyz, rotate, scale: [1, 1, 1] },
    });
  }

  if (skipped && onSkip) {
    onSkip(`${skipped} 个 3D Body 未关联模型（外部模型引用、非封装 Body 或缺少内嵌数据）`);
  }
  return out;
}

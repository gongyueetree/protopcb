/**
 * design-core/geometry/altium-records.ts
 * Altium Designer 文件的**记录层**：把 OLE 复合文档（.PcbDoc / .SchDoc）拆成记录。
 *
 * AD 的文件是 OLE Compound Binary（CFB），每个逻辑段是一条 `<Name>/Data` 流。
 * 流内有两种编码：
 *   - 文本属性记录：`|KEY=VALUE|KEY=VALUE|`，前面 4 字节是长度
 *   - 二进制记录：Pads6 / Tracks6 / Vias6 这类，定长字段按偏移读
 *
 * 这一层只做"读出来"，不做语义映射（映射在 altium-pcb-import.ts）。
 */
import * as CFB from 'cfb';

export type AltiumProps = Record<string, string>;

const cp1252 = new TextDecoder('windows-1252');
const utf8 = new TextDecoder();

/** 单条记录的上限：畸形文件不该把内存撑爆 */
const MAX_RECORDS = 200_000;

/**
 * 打开 AD 文件，返回按段名取流的函数。
 * @throws 文件不是有效的 CFB 容器时
 */
export function openAltiumFile(bytes: Uint8Array): (streamName: string) => Uint8Array {
  const cf = CFB.read(bytes, { type: 'array' });
  const index = new Map<string, Uint8Array>();
  cf.FullPaths.forEach((path, i) => {
    const content = cf.FileIndex[i]?.content;
    if (!content) return;
    // 路径形如 "Root Entry/Pads6/Data"，按去掉根节点后的相对路径索引
    const rel = path.replace(/^[^/]*\//, '');
    index.set(rel, content instanceof Uint8Array ? content : new Uint8Array(content as number[]));
  });
  return (name: string) => index.get(name) ?? new Uint8Array(0);
}

/**
 * 长度前缀记录拆分。每条记录：4 字节小端长度（高字节是标志，掩掉）+ 内容。
 */
export function altiumBlocks(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (!data.length) return out;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset < data.length;) {
    if (offset + 4 > data.length) break;
    if (out.length >= MAX_RECORDS) throw new Error('AD 记录数异常（超过 20 万条）');
    const size = view.getUint32(offset, true) & 0xffffff;
    offset += 4;
    if (!size || offset + size > data.length) break;   // 截断的尾部：保留已读到的
    out.push(data.subarray(offset, offset + size));
    offset += size;
  }
  return out;
}

/**
 * 文本属性记录 → 键值表。键统一大写。
 * AD 会同时写 code page 与 UTF-8 两份（后者以 `%UTF8%` 前缀），UTF-8 覆盖前者。
 */
export function altiumProperties(data: Uint8Array): AltiumProps {
  const result: AltiumProps = Object.create(null) as AltiumProps;
  for (const entry of cp1252.decode(data).replace(/\0+$/, '').split('|')) {
    const i = entry.indexOf('=');
    if (i > 0) result[entry.slice(0, i).toUpperCase()] = entry.slice(i + 1);
  }
  for (const entry of utf8.decode(data).replace(/\0+$/, '').split('|')) {
    const i = entry.indexOf('=');
    if (entry.startsWith('%UTF8%') && i > 6) result[entry.slice(6, i).toUpperCase()] = entry.slice(i + 1);
  }
  return result;
}

/**
 * 取某段的全部属性记录。
 * PCB 的段是 `<Name>/Data` 子流；原理图整份就在一个 `FileHeader` 流里（没有 /Data），
 * 两种都试一下，谁有数据用谁。
 */
export function readPropsSection(stream: (n: string) => Uint8Array, section: string): AltiumProps[] {
  const data = stream(`${section}/Data`);
  return altiumBlocks(data.length ? data : stream(section)).map(altiumProperties);
}

/**
 * 二进制记录遍历。每条以 1 字节类型开头，随后是 `blocksPerRecord` 个长度前缀块。
 * Pads6 每条 6 块（名称/描述/…/几何），Tracks6 与 Vias6 各 1 块。
 */
export function forEachBinaryRecord(
  data: Uint8Array,
  recordType: number,
  blocksPerRecord: number,
  handler: (blocks: Uint8Array[], index: number) => void,
): void {
  if (!data.length) return;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  let index = 0;
  while (offset < data.length) {
    if (data[offset] !== recordType) break;      // 遇到未知记录类型：停下而不是抛错，已读的仍有效
    offset += 1;
    const blocks: Uint8Array[] = [];
    let ok = true;
    for (let k = 0; k < blocksPerRecord; k++) {
      if (offset + 4 > data.length) { ok = false; break; }
      const len = view.getUint32(offset, true) & 0xffffff;
      offset += 4;
      if (offset + len > data.length) { ok = false; break; }
      blocks.push(data.subarray(offset, offset + len));
      offset += len;
    }
    if (!ok) break;
    handler(blocks, index++);
    if (index >= MAX_RECORDS) break;
  }
}

/** 二进制块的定长字段读取器。AD 内部坐标单位是 1/10000 mil。 */
export function fieldReader(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const COORD = 0.00000254;   // 1/10000 mil → mm
  return {
    u16: (i: number) => (i + 2 <= b.length ? v.getUint16(i, true) : 0),
    f64: (i: number) => (i + 8 <= b.length ? v.getFloat64(i, true) : 0),
    mm: (i: number) => (i + 4 <= b.length ? v.getInt32(i, true) * COORD : 0),
    byte: (i: number) => (i < b.length ? b[i] : 0),
  };
}

/** 属性里的长度值：默认是 mil，带 mm 后缀则已是毫米 */
export function altiumLength(raw = '0'): number {
  const s = String(raw).trim();
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return s.toLowerCase().endsWith('mm') ? n : n * 0.0254;
}

/** 首块里的短字符串（1 字节长度 + 内容），用于焊盘编号 */
export function shortString(block: Uint8Array): string {
  if (!block.length) return '';
  const len = Math.min(block[0], block.length - 1);
  return cp1252.decode(block.subarray(1, 1 + len));
}

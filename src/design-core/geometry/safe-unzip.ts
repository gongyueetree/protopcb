/**
 * KiCad 工程 ZIP 的安全解压。
 *
 * 浏览器端直接 unzipSync 有两个风险：
 *  1. ZIP 炸弹——几百 KB 的压缩包解出几 GB，直接把标签页 OOM 掉；
 *  2. zip-slip——条目名带 `../` 或绝对路径，虽然我们不写磁盘，
 *     但这类条目本身说明包不可信，一律拒绝。
 *
 * 因此先读中央目录拿到各条目的**声明**大小做预检，再实际解压，
 * 并对解压结果二次核对（声明值可以造假）。
 */
import type { Unzipped } from 'fflate';

export interface ZipLimits {
  /** 压缩包本身上限 */
  maxZipBytes: number;
  /** 解压后总大小上限 */
  maxTotalBytes: number;
  /** 单个文件上限 */
  maxFileBytes: number;
  /** 文件数量上限 */
  maxFiles: number;
  /** 压缩比上限（解压后 / 压缩包），超过视为炸弹 */
  maxRatio: number;
}

// 浏览器内解压的合理默认值（本轮下调：压缩 ≤50MB / 解压总量 ≤200MB / 单文件 ≤64MB /
// ≤2000 个文件 / 压缩比 ≤100）。特殊工程可经 limits 参数放宽。
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxZipBytes: 50 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxFiles: 2000,
  maxRatio: 100,
};

export class ZipSafetyError extends Error {}

/** 应当忽略的条目：macOS 资源叉、目录项、隐藏元数据 */
export function isIgnorableEntry(name: string): boolean {
  return name.startsWith('__MACOSX/')
    || name.includes('/__MACOSX/')
    || /(^|\/)\._/.test(name)
    || /(^|\/)\.DS_Store$/.test(name)
    || name.endsWith('/');
}

/** zip-slip / 绝对路径 / 盘符 / 控制字符 —— 任一命中即视为不可信 */
export function isUnsafeEntryName(name: string): boolean {
  if (!name || name.length > 512) return true;
  if (name.startsWith('/') || name.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(name)) return true;
  if (name.split(/[\\/]/).some((seg) => seg === '..')) return true;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return true;
  return false;
}

/**
 * 安全解压。抛 ZipSafetyError 时消息可直接展示给用户。
 * @param bytes 压缩包字节
 * @param limits 覆盖默认限额
 */
/** 中央目录条目元数据（未解压任何数据，仅读目录声明值） */
export interface ZipEntryMeta {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

const rd16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const rd32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * 中央目录预检 —— **在任何 inflate 发生之前**完成全部限额检查。
 *
 * 此前 maxFiles / maxTotalBytes / ratio 是在 unzipSync 完成后才核对的：
 * 多条目炸弹（大量小 entry，累计解压量巨大）会先把内存吃满，再告诉用户"太大"。
 * 现在先解析 EOCD + 中央目录，逐条读取声明的 compressed/uncompressed 大小，
 * 条目数 / 单文件 / 累计 / 压缩比 / 非法路径任一超限直接拒绝，一个字节都不解压。
 * （声明值可以造假 → 解压后仍保留二次核对，见 safeUnzip 下半段。）
 */
export function preScanZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipEntryMeta[] {
  const L = { ...DEFAULT_ZIP_LIMITS, ...limits };
  // 1) 从尾部找 EOCD（签名 0x06054b50；注释区最长 64KB）
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const scanFrom = Math.max(0, bytes.length - 22 - 65536);
  for (let i = bytes.length - 22; i >= scanFrom; i--) {
    if (rd32(bytes, i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipSafetyError('压缩包解析失败：未找到 ZIP 目录（可能损坏或不是 ZIP）');
  const cdCount = rd16(bytes, eocd + 10);
  const cdSize = rd32(bytes, eocd + 12);
  const cdOffset = rd32(bytes, eocd + 16);
  if (cdCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipSafetyError('不支持 ZIP64 超大压缩包');
  }
  if (cdCount > L.maxFiles) {
    throw new ZipSafetyError(`压缩包含 ${cdCount} 个条目，超过 ${L.maxFiles} 个上限`);
  }
  if (cdOffset + cdSize > bytes.length) throw new ZipSafetyError('压缩包目录越界，文件可能损坏');

  // 2) 遍历中央目录条目（签名 0x02014b50）
  const CEN_SIG = 0x02014b50;
  const out: ZipEntryMeta[] = [];
  let p2 = cdOffset;
  let total = 0;
  for (let i = 0; i < cdCount; i++) {
    if (p2 + 46 > bytes.length || rd32(bytes, p2) !== CEN_SIG) {
      throw new ZipSafetyError('压缩包中央目录损坏');
    }
    const compressedSize = rd32(bytes, p2 + 20);
    const uncompressedSize = rd32(bytes, p2 + 24);
    const nameLen = rd16(bytes, p2 + 28);
    const extraLen = rd16(bytes, p2 + 30);
    const cmtLen = rd16(bytes, p2 + 32);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ZipSafetyError('不支持 ZIP64 超大条目');
    }
    const name = new TextDecoder().decode(bytes.subarray(p2 + 46, p2 + 46 + nameLen));
    p2 += 46 + nameLen + extraLen + cmtLen;
    if (isIgnorableEntry(name)) continue;
    if (isUnsafeEntryName(name)) {
      throw new ZipSafetyError(`压缩包内含非法路径条目：${name.slice(0, 80)}`);
    }
    if (uncompressedSize > L.maxFileBytes) {
      throw new ZipSafetyError(`包内文件 ${name.slice(0, 60)} 声明解压后超过 ${Math.round(L.maxFileBytes / 1024 / 1024)}MB`);
    }
    total += uncompressedSize;
    if (total > L.maxTotalBytes) {
      throw new ZipSafetyError(`声明解压总量超过 ${Math.round(L.maxTotalBytes / 1024 / 1024)}MB 上限（多条目累计），已在解压前拒绝`);
    }
    out.push({ name, compressedSize, uncompressedSize });
  }
  const ratio = bytes.length > 0 ? total / bytes.length : 0;
  if (ratio > L.maxRatio && total > 8 * 1024 * 1024) {
    throw new ZipSafetyError(`声明压缩比异常（${ratio.toFixed(0)}:1），疑似 ZIP 炸弹，已在解压前拒绝`);
  }
  return out;
}

export async function safeUnzip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): Promise<Unzipped> {
  const L = { ...DEFAULT_ZIP_LIMITS, ...limits };

  if (bytes.length > L.maxZipBytes) {
    throw new ZipSafetyError(`压缩包 ${(bytes.length / 1024 / 1024).toFixed(1)}MB，超过 ${Math.round(L.maxZipBytes / 1024 / 1024)}MB 上限`);
  }

  // ── 阶段一：中央目录预检（0 字节解压）──
  preScanZip(bytes, L);

  const { unzipSync } = await import('fflate');
  let entries: Unzipped;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (isIgnorableEntry(file.name)) return false;
        if (isUnsafeEntryName(file.name)) {
          throw new ZipSafetyError(`压缩包内含非法路径条目：${file.name.slice(0, 80)}`);
        }
        // 声明大小预检：能在真正解压前挡掉大部分炸弹
        if (file.originalSize != null && file.originalSize > L.maxFileBytes) {
          throw new ZipSafetyError(`包内文件 ${file.name.slice(0, 60)} 解压后超过 ${Math.round(L.maxFileBytes / 1024 / 1024)}MB`);
        }
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ZipSafetyError) throw e;
    throw new ZipSafetyError('压缩包解析失败，可能已损坏或不是有效的 ZIP');
  }

  const names = Object.keys(entries);
  if (names.length > L.maxFiles) {
    throw new ZipSafetyError(`压缩包含 ${names.length} 个文件，超过 ${L.maxFiles} 个上限`);
  }

  // 解压后二次核对（声明值可以造假）
  let total = 0;
  for (const n of names) {
    const size = entries[n].length;
    if (size > L.maxFileBytes) {
      throw new ZipSafetyError(`包内文件 ${n.slice(0, 60)} 解压后 ${(size / 1024 / 1024).toFixed(1)}MB，超过上限`);
    }
    total += size;
    if (total > L.maxTotalBytes) {
      throw new ZipSafetyError(`解压后总大小超过 ${Math.round(L.maxTotalBytes / 1024 / 1024)}MB 上限`);
    }
  }
  const ratio = bytes.length > 0 ? total / bytes.length : 0;
  if (ratio > L.maxRatio && total > 8 * 1024 * 1024) {
    throw new ZipSafetyError(`压缩比异常（${ratio.toFixed(0)}:1），疑似恶意压缩包`);
  }

  return entries;
}

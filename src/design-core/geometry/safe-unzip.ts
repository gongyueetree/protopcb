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

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxZipBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxFiles: 5000,
  maxRatio: 200,
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
export async function safeUnzip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): Promise<Unzipped> {
  const L = { ...DEFAULT_ZIP_LIMITS, ...limits };

  if (bytes.length > L.maxZipBytes) {
    throw new ZipSafetyError(`压缩包 ${(bytes.length / 1024 / 1024).toFixed(1)}MB，超过 ${Math.round(L.maxZipBytes / 1024 / 1024)}MB 上限`);
  }

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

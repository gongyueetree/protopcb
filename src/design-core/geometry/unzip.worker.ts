/**
 * unzip.worker.ts — ZIP 解压 Web Worker
 * 30~60MB 工程在主线程 unzipSync 会卡死 React UI；解压全程移到 Worker，
 * 主线程只收 Transferable 结果。安全检查（preScanZip + safeUnzip 全部限额）
 * 在 Worker 内同样执行。
 */
import { safeUnzip, ZipSafetyError, type ZipLimits } from './safe-unzip';

self.onmessage = async (ev: MessageEvent<{ bytes: Uint8Array; limits?: Partial<ZipLimits> }>) => {
  try {
    const entries = await safeUnzip(ev.data.bytes, ev.data.limits ?? {});
    // Transferable：把每个条目的 buffer 转移所有权（零拷贝）
    const transfer: ArrayBuffer[] = [];
    for (const k of Object.keys(entries)) {
      const b = entries[k].buffer;
      if (b instanceof ArrayBuffer) transfer.push(b);
    }
    (self as unknown as Worker).postMessage({ ok: true, entries }, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({
      ok: false,
      safety: e instanceof ZipSafetyError,
      error: String((e as Error).message ?? e),
    });
  }
};

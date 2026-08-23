/**
 * safe-unzip-worker.ts — safeUnzip 的 Worker 前端封装。
 * 浏览器：解压在 Web Worker 内进行，避免大工程卡死 UI 线程；
 * 非浏览器 / Worker 构建失败：回落到主线程 safeUnzip（安全检查完全一致）。
 */
import type { Unzipped } from 'fflate';
import { safeUnzip, ZipSafetyError, type ZipLimits } from './safe-unzip';

export async function safeUnzipOffThread(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): Promise<Unzipped> {
  if (typeof Worker === 'undefined') return safeUnzip(bytes, limits);
  let worker: Worker;
  try {
    worker = new Worker(new URL('./unzip.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return safeUnzip(bytes, limits);   // 环境不支持 module worker → 主线程兜底
  }
  try {
    return await new Promise<Unzipped>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ZipSafetyError('解压超时（120 秒），工程可能过大')), 120_000);
      worker.onmessage = (ev: MessageEvent<{ ok: boolean; entries?: Unzipped; error?: string; safety?: boolean }>) => {
        clearTimeout(timer);
        if (ev.data.ok && ev.data.entries) resolve(ev.data.entries);
        else reject(ev.data.safety ? new ZipSafetyError(ev.data.error ?? '解压失败') : new Error(ev.data.error ?? '解压失败'));
      };
      worker.onerror = (e) => { clearTimeout(timer); reject(new Error('解压 Worker 异常：' + e.message)); };
      // buffer 转移所有权（调用方之后不再使用原 bytes）
      worker.postMessage({ bytes, limits }, [bytes.buffer]);
    });
  } finally {
    worker.terminate();
  }
}

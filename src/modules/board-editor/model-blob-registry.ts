/**
 * modules/board-editor/model-blob-registry.ts
 * 工程 zip 里带的 STEP 文件 → blob URL 的**生命周期登记**。
 *
 * 此前 App 直接 URL.createObjectURL 然后就忘了它：反复导入工程，每次都是一批新 blob，
 * 旧的既不能被 GC（浏览器按 URL 持有）也没人 revoke —— 持续泄漏。
 *
 * 规则：
 *   register()  登记（一个封装名对应一个 URL；同名再登记先撤旧的）
 *   revokeAll() 重新导入 / 清空项目 / 应用卸载时整体撤销，并把 STEP 缓存里对应模型驱逐
 */
import { evictStepModel } from './step-loader';

const byFootprint = new Map<string, string>();
const all = new Set<string>();

export function registerModelBlob(footprintName: string, bytes: Uint8Array, mime = 'application/step'): string {
  const prev = byFootprint.get(footprintName);
  if (prev) revokeModelBlob(prev);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  byFootprint.set(footprintName, url);
  all.add(url);
  return url;
}

export function revokeModelBlob(url: string): void {
  if (!all.has(url)) return;
  try { URL.revokeObjectURL(url); } catch { /* 已失效 */ }
  all.delete(url);
  for (const [fp, u] of byFootprint) if (u === url) byFootprint.delete(fp);
  evictStepModel(url);
}

/** 重新导入 / 清项目 / 卸载：整体撤销 */
export function revokeAllModelBlobs(): number {
  const n = all.size;
  for (const url of [...all]) revokeModelBlob(url);
  return n;
}

export const isModelBlob = (url: string | undefined) => !!url && all.has(url);
export const __modelBlobCount = () => all.size;

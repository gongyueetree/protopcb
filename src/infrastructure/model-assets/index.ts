/**
 * infrastructure/model-assets/index.ts
 * 工程 zip 里带的 STEP 文件 → blob URL 的**生命周期登记**。
 *
 * 此前 App 直接 URL.createObjectURL 然后就忘了它：反复导入工程，每次都是一批新 blob，
 * 旧的既不能被 GC（浏览器按 URL 持有）也没人 revoke —— 持续泄漏。
 *
 * 规则：
 *   register()  登记（一个封装名对应一个 URL；同名再登记先撤旧的）
 *   revokeAll() 重新导入 / 清空项目 / 应用卸载时整体撤销，并把 STEP 缓存里对应模型驱逐
 */
import { evictStepModel } from '../../modules/board-editor/step-loader';

/**
 * 资产键 → blob URL。键**不是** footprintName：同一封装的不同实例可以用不同模型
 * （Altium 的内嵌模型按模型 ID 绑定，KiCad 的工程模型按文件路径）。
 * 用调用方给的稳定键，避免把两个模型压成一个。
 */
const byAssetKey = new Map<string, string>();
const all = new Set<string>();

export function registerModelBlob(assetKey: string, bytes: Uint8Array, mime = 'application/step'): string {
  const prev = byAssetKey.get(assetKey);
  if (prev) return prev;                       // 同一资产复用同一个 blob（多个实例共享）
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  byAssetKey.set(assetKey, url);
  all.add(url);
  return url;
}

export function revokeModelBlob(url: string): void {
  if (!all.has(url)) return;
  try { URL.revokeObjectURL(url); } catch { /* 已失效 */ }
  all.delete(url);
  for (const [k, u] of byAssetKey) if (u === url) byAssetKey.delete(k);
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

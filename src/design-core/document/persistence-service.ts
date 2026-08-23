/**
 * design-core/document/persistence-service.ts
 * ProjectPersistenceService —— 项目本地持久化的**唯一**入口。
 *
 * 此前同时存在两套 autosave（App.tsx 直写 'cc_doc_autosave'、
 * modules/report/persistence.ts 写 'cc:autosave'），互不知情、格式不同、
 * 首次会话还会 removeItem 删掉用户存档。本服务统一：
 *   save()：防抖写入唯一键（含时间戳）
 *   load()：schema 校验 + 版本迁移 + 损坏恢复（损坏存档转移到备份键，不丢弃）
 *   旧键 'cc:autosave' 只读迁移一次后清除
 *
 * 原则：自动存档尽量保住用户数据 —— 永不自动删除；清空由用户显式点"新建/清空"。
 */
import { parseDocument } from './schema';
import type { CircuitCanvasDocument } from './types';

const KEY = 'cc_doc_autosave';
const LEGACY_KEY = 'cc:autosave';
const CORRUPT_BACKUP_KEY = 'cc_doc_autosave_corrupt';
const DEBOUNCE_MS = 800;

function lsGet(k: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch { return null; }
}
function lsSet(k: string, v: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch { /* 空间不足等 */ }
}
function lsDel(k: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); } catch { /* ignore */ }
}

export interface LoadedAutosave {
  doc: CircuitCanvasDocument;
  /** 保存时刻（本地时间字符串） */
  at: string | null;
}

let timer: ReturnType<typeof setTimeout> | null = null;

export const ProjectPersistenceService = {
  /** 防抖保存（doc 变更即调；实际写入延迟 DEBOUNCE_MS 合并） */
  saveDebounced(doc: CircuitCanvasDocument, onSaved?: (at: string) => void): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const at = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      lsSet(KEY, JSON.stringify({ doc, at }));
      onSaved?.(at);
    }, DEBOUNCE_MS);
  },

  /** 立即保存（页面卸载前等场景） */
  saveNow(doc: CircuitCanvasDocument): void {
    if (timer) { clearTimeout(timer); timer = null; }
    const at = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    lsSet(KEY, JSON.stringify({ doc, at }));
  },

  /**
   * 加载自动存档。
   * - schema 校验 + migrateDocument 版本迁移（见 schema.ts 的显式迁移链）
   * - 损坏存档：**转移**到备份键（供人工恢复），不直接丢弃
   * - 兼容旧 'cc:autosave' 键：读到即迁移到统一键并清除旧键
   */
  load(): LoadedAutosave | null {
    // 1) 统一键（信封格式 { doc, at }）
    const raw = lsGet(KEY);
    if (raw) {
      try {
        const envelope = JSON.parse(raw) as { doc?: unknown; at?: string };
        const r = parseDocument(envelope.doc ?? envelope);   // 兼容裸文档格式
        if (r.ok) return { doc: r.document, at: envelope.at ?? null };
        // 结构校验失败 → 备份后放弃本次恢复（数据保留，不静默删除）
        lsSet(CORRUPT_BACKUP_KEY, raw);
        lsDel(KEY);
        console.warn('[persistence] 自动存档结构校验失败，已转移到备份键 ' + CORRUPT_BACKUP_KEY + '：' + r.error.slice(0, 200));
      } catch {
        lsSet(CORRUPT_BACKUP_KEY, raw);
        lsDel(KEY);
        console.warn('[persistence] 自动存档 JSON 损坏，已转移到备份键 ' + CORRUPT_BACKUP_KEY);
      }
    }
    // 2) 旧键（裸序列化文档）：一次性迁移
    const legacy = lsGet(LEGACY_KEY);
    if (legacy) {
      try {
        const r = parseDocument(JSON.parse(legacy));
        lsDel(LEGACY_KEY);
        if (r.ok) {
          const at = null;
          lsSet(KEY, JSON.stringify({ doc: r.document, at }));
          return { doc: r.document, at };
        }
      } catch { lsDel(LEGACY_KEY); }
    }
    return null;
  },

  /** 用户显式"新建/清空"时调用 —— 这是唯一允许删除存档的路径 */
  clearByUser(): void {
    lsDel(KEY);
  },
};

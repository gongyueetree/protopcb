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
import { UNTITLED_DOC_NAME, deserializeDocument } from './factory';
import { KEYS } from '../../shared/storage';

const KEY = KEYS.docAutosave;
const LEGACY_KEY = 'cc:autosave';
const CORRUPT_BACKUP_KEY = KEYS.docAutosaveCorrupt;
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

/**
 * 文档是否有值得恢复的内容。
 *
 * 此前恢复条件是 `components.length > 0` —— 一个改了名字、调了板框、
 * 设了外壳参数但还没放器件的工程，刷新后会被当成空白丢弃。
 * 判据必须覆盖用户可能做过的**任何**改动。
 */
/**
 * zip 导入时挂上的工程自带 3D 模型用的是 blob: 地址，只在那次会话有效。
 * 存档恢复时把它们清掉：留着只会让每个器件先报一次"加载失败"，
 * 用户要恢复这些模型需要重新导入 zip（页面会提示）。
 */
export function stripSessionOnlyUrls(doc: CircuitCanvasDocument): { doc: CircuitCanvasDocument; stripped: number } {
  let stripped = 0;
  const components = doc.components.map((c) => {
    if (c.display?.stepUrl?.startsWith('blob:')) {
      stripped++;
      const { stepUrl: _drop, ...rest } = c.display;
      void _drop;
      return { ...c, display: { ...rest, sessionModelLost: true } };
    }
    return c;
  });
  return { doc: stripped ? { ...doc, components } : doc, stripped };
}

export function docHasContent(doc: CircuitCanvasDocument): boolean {
  if (doc.components.length) return true;
  if ((doc.tracks?.length ?? 0) > 0 || (doc.vias?.length ?? 0) > 0) return true;
  if (doc.schematicSheets && Object.keys(doc.schematicSheets).length) return true;
  if ((doc.functionalBlocks?.length ?? 0) > 0 || (doc.connections?.length ?? 0) > 0) return true;
  if (doc.designIntent) return true;
  if (doc.enclosure?.enabled) return true;
  if (doc.board.mountingHoles?.length) return true;
  // 板框或项目名被改过也算有内容
  if (doc.board.widthMm !== 100 || doc.board.heightMm !== 80) return true;   // createBoard 的默认值
  if (doc.board.shape !== 'rect') return true;
  if (doc.name && doc.name !== UNTITLED_DOC_NAME) return true;
  return false;
}

export interface LoadedAutosave {
  doc: CircuitCanvasDocument;
  /** 保存时刻（本地时间字符串） */
  at: string | null;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * 注意：本服务是**浏览器本地**自动存档（localStorage），未登录用户同样可用 ——
 * 它保证刷新不丢，但只在这台设备、这个浏览器里。
 * 「保存到云端空间 / 打开我的设计」属于 design.save / design.open 能力，
 * 需要登录，走 ezPLM 侧存储，不在本服务范围内。
 */
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
        if (r.ok) return { doc: stripSessionOnlyUrls(r.document).doc, at: envelope.at ?? null };
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

/**
 * 从用户选择的文件读入设计 JSON。
 * 放在 Domain：application 层的导入服务需要它，不该为此依赖 modules/report。
 * FileReader 是浏览器能力而非 UI 依赖，Domain 使用它不破坏边界。
 */
export function importDocumentFromFile(file: File): Promise<CircuitCanvasDocument> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(deserializeDocument(String(reader.result))); }
      catch (e) { reject(e); }
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

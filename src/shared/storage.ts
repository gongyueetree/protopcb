/**
 * shared/storage.ts
 * localStorage 键的唯一定义 + 一次性迁移（cc_* / cc:* → protopcb:*）。
 *
 * 所有需要持久化的模块只能通过 `KEYS` 取键名，不许再手写字符串。
 * 迁移策略：读旧键 → 写新键 → 校验能读回 → 删旧键。任一步失败都保留旧键，
 * 用户的自动存档与自建器件在最坏情况下也只是"没迁移"，不会丢。
 */

const NS = 'protopcb';

/** 固定键 */
export const KEYS = {
  docAutosave: `${NS}:doc_autosave`,
  docAutosaveCorrupt: `${NS}:doc_autosave_corrupt`,
  customParts: `${NS}:custom_parts`,
  lang: `${NS}:lang`,
  trCache: `${NS}:tr_cache`,
  pcbVisualMode: `${NS}:pcb_visual_mode`,
} as const;

/** 带参数的键 */
export const keyOf = {
  manualPrice: (mpn: string) => `${NS}:manual_price:${mpn}`,
  ksym: (name: string) => `${NS}:ksym:${name}`,
  ksymMpn: (mpn: string) => `${NS}:ksym_mpn:${mpn}`,
  /** 本地保存的设计（LocalStorageProjectProvider） */
  project: (projectId: string) => `${NS}:design:${projectId}`,
};

/** 旧键 → 新键（固定键） */
const LEGACY_FIXED: Record<string, string> = {
  'cc_doc_autosave': KEYS.docAutosave,
  'cc:autosave': KEYS.docAutosave,          // 更老的一代
  'cc_doc_autosave_corrupt': KEYS.docAutosaveCorrupt,
  'cc_custom_parts': KEYS.customParts,
  'cc_lang': KEYS.lang,
  'cc_tr_cache': KEYS.trCache,
  'cc_pcb_visual_mode': KEYS.pcbVisualMode,
};
/** 旧前缀 → 新前缀（带参数的键） */
const LEGACY_PREFIX: [string, (rest: string) => string][] = [
  ['cc:design:', (r) => keyOf.project(r)],
  ['cc_manual_price_', (r) => keyOf.manualPrice(r)],
  ['cc_ksym_mpn_', (r) => keyOf.ksymMpn(r)],
  ['cc_ksym_', (r) => keyOf.ksym(r)],
];

const MIGRATED_FLAG = `${NS}:migrated_v1`;

export interface MigrationReport { migrated: string[]; skipped: string[]; failed: string[] }

/**
 * 一次性迁移。幂等：完成后写标记，之后调用直接返回。
 * 新键已存在时不覆盖（可能是本次会话刚写的），只删旧键。
 */
export function migrateLegacyStorage(store: Storage = localStorage): MigrationReport {
  const report: MigrationReport = { migrated: [], skipped: [], failed: [] };
  try { if (store.getItem(MIGRATED_FLAG)) return report; } catch { return report; }

  const move = (oldKey: string, newKey: string) => {
    try {
      const v = store.getItem(oldKey);
      if (v == null) return;
      if (store.getItem(newKey) == null) {
        store.setItem(newKey, v);
        if (store.getItem(newKey) !== v) { report.failed.push(oldKey); return; }   // 校验能读回
      } else {
        report.skipped.push(oldKey);
      }
      store.removeItem(oldKey);
      if (!report.skipped.includes(oldKey)) report.migrated.push(oldKey);
    } catch { report.failed.push(oldKey); }
  };

  for (const [oldKey, newKey] of Object.entries(LEGACY_FIXED)) move(oldKey, newKey);
  // 带参数的键要遍历全部 key
  const all: string[] = [];
  try { for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k) all.push(k); } } catch { /* 忽略 */ }
  for (const k of all) {
    for (const [prefix, mk] of LEGACY_PREFIX) {
      if (k.startsWith(prefix)) { move(k, mk(k.slice(prefix.length))); break; }
    }
  }
  // 只有没有失败项才标记完成，失败的下次启动会再试
  if (!report.failed.length) { try { store.setItem(MIGRATED_FLAG, new Date().toISOString()); } catch { /* 忽略 */ } }
  return report;
}

// 在模块加载时就迁移：i18n / pcbViewStore 等在**模块初始化**阶段读 localStorage，
// 而它们都 import 本文件，ESM 保证本文件先求值 —— 比在 App 组件里调用更早、更可靠。
if (typeof localStorage !== 'undefined') {
  try { migrateLegacyStorage(); } catch { /* 迁移失败不影响启动 */ }
}

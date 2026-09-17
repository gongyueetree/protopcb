/**
 * 离开页面前必须把防抖窗口内的最后一笔写入落盘（否则改完立刻刷新会丢）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectPersistenceService } from '../../src/design-core/document/persistence-service';
import { createDocument } from '../../src/design-core/document/factory';
import { KEYS } from '../../src/shared/storage';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
}

describe('saveNow / saveDebounced', () => {
  beforeEach(() => { localStorage.removeItem(KEYS.docAutosave); vi.useRealTimers(); });

  it('saveDebounced 在窗口内不落盘，saveNow 立即落盘', () => {
    vi.useFakeTimers();
    const doc = createDocument({ name: '改名前' });
    ProjectPersistenceService.saveDebounced(doc);
    expect(localStorage.getItem(KEYS.docAutosave)).toBeNull();      // 还在防抖窗口里

    const renamed = { ...doc, name: '改名后' };
    ProjectPersistenceService.saveNow(renamed);
    const raw = localStorage.getItem(KEYS.docAutosave);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).doc.name).toBe('改名后');
    vi.useRealTimers();
  });

  it('saveNow 之后再等防抖到期，不会用旧文档覆盖', () => {
    vi.useFakeTimers();
    const doc = createDocument({ name: '旧' });
    ProjectPersistenceService.saveDebounced(doc);
    ProjectPersistenceService.saveNow({ ...doc, name: '新' });
    vi.advanceTimersByTime(2000);                                   // 防抖到期
    expect(JSON.parse(localStorage.getItem(KEYS.docAutosave)!).doc.name).toBe('新');
    vi.useRealTimers();
  });
});

describe('useProjectPersistence 注册了离开页面的 flush', () => {
  it('监听 pagehide 与 visibilitychange，且卸载时也落盘', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../../src/modules/report/useProjectPersistence.ts', import.meta.url), 'utf8'));
    expect(src).toMatch(/addEventListener\('pagehide', flush\)/);
    expect(src).toMatch(/addEventListener\('visibilitychange', onHidden\)/);
    expect(src).toMatch(/flush\(\);\s*\/\/ 组件卸载/);
    expect(src.includes("addEventListener('beforeunload'")).toBe(false);   // 不用会弹框的那个
  });
});


describe('?fresh=1 绝不删用户存档（数据安全）', () => {
  it('只跳过恢复，不调用 clearByUser，并从地址栏移除参数', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../../src/modules/report/useProjectPersistence.ts', import.meta.url), 'utf8'));
    // 整个文件里都不该再出现 clearByUser（清空只能来自用户显式操作）
    expect(src).not.toMatch(/clearByUser/);
    expect(src).toMatch(/history\.replaceState/);
    expect(src).toMatch(/fresh=1/);
  });
  it('存档仍可被普通刷新恢复', () => {
    const doc = { ...createDocument({ name: '仍在' }), components: [] };
    ProjectPersistenceService.saveNow(doc);
    expect(ProjectPersistenceService.load()?.doc.name).toBe('仍在');
  });
});

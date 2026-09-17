/**
 * useProjectPersistence — App.tsx 拆薄（第一片）：自动保存/恢复逻辑抽为 hook。
 * App 只做 UI composition；持久化细节全部在 ProjectPersistenceService。
 */
import { useEffect, useRef, useState } from 'react';
import { ProjectPersistenceService, docHasContent } from '../../design-core/document/persistence-service';
import type { CircuitCanvasDocument } from '../../design-core/document/types';

export function useProjectPersistence(
  doc: CircuitCanvasDocument,
  loadDocument: (doc: CircuitCanvasDocument) => void,
): { savedAt: string | null } {
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const restored = useRef(false);
  /** 最近一次的文档：pagehide 时用它落盘（闭包里拿不到最新 props） */
  const latestDoc = useRef<CircuitCanvasDocument | null>(null);

  // 启动恢复：仅当当前画布为空时恢复存档（服务内部已做 schema 校验 + 迁移 + 损坏备份）。
  // URL 带 ?fresh=1 时跳过恢复并清掉存档 —— 反复导入工程做对比时不用每次手动清空画布。
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (typeof location !== 'undefined' && /(?:\?|&)fresh=1(?:&|$)/.test(location.search)) {
      ProjectPersistenceService.clearByUser();
      return;
    }
    const saved = ProjectPersistenceService.load();
    // 恢复条件用同一个 docHasContent：存档有内容、当前画布还没内容
    if (saved && docHasContent(saved.doc) && !docHasContent(doc)) {
      loadDocument(saved.doc);
      setSavedAt(saved.at);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDocument]);

  // doc 变更 → 防抖保存（唯一 autosave 路径）
  useEffect(() => {
    latestDoc.current = doc;
    ProjectPersistenceService.saveDebounced(doc, setSavedAt);
  }, [doc]);

  /**
   * 页面离开前把未落盘的那一笔刷掉。
   * 防抖窗口是 800ms —— 改完名字立刻刷新/关标签，最后一次修改就丢了。
   * 用 pagehide + visibilitychange:hidden：前者覆盖关闭/前进后退缓存，后者覆盖移动端切后台，
   * 两者都不会像 beforeunload 那样弹确认框，也不会阻塞卸载。
   */
  useEffect(() => {
    const flush = () => { if (latestDoc.current) ProjectPersistenceService.saveNow(latestDoc.current); };
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      flush();                                   // 组件卸载（切换工作区）也落盘
    };
  }, []);

  return { savedAt };
}


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

  // 启动恢复：仅当当前画布为空时恢复存档（服务内部已做 schema 校验 + 迁移 + 损坏备份）
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
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
    ProjectPersistenceService.saveDebounced(doc, setSavedAt);
  }, [doc]);

  return { savedAt };
}


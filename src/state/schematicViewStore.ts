/**
 * state/schematicViewStore.ts
 * 原理图"当前查看哪一页"—— UI 状态，不进文档、不持久化。
 * 文档只保存 schematicSheets + rootSheetFile；此前还复制了一份 schematicSheet 作当前页，
 * 一份数据两处存放，切页还会 touch 文档。
 */
import { create } from 'zustand';

interface SchematicViewState {
  /** 当前查看的页面文件名；undefined = 跟随文档的 rootSheetFile */
  activeSheetFile?: string;
  showSheet: (file: string) => void;
  reset: () => void;
}

export const useSchematicViewStore = create<SchematicViewState>((set) => ({
  activeSheetFile: undefined,
  showSheet: (file) => set({ activeSheetFile: file }),
  reset: () => set({ activeSheetFile: undefined }),
}));

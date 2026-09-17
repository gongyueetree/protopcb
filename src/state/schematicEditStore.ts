/**
 * state/schematicEditStore.ts
 * 原理图编辑状态 —— 独立 zustand store，跨全屏/非全屏共享，不因组件卸载丢失。
 */
import { create } from 'zustand';

export interface SchNet { id: string; from: string; to: string; label: string; color: string; midDx?: number; }
export interface SymState { x: number; y: number; rotation: number; refDes?: string; value?: string; }

interface SchematicState {
  pos: Record<string, SymState>;
  nets: SchNet[] | null;
  zoom: number;
  pan: { x: number; y: number };
  setPos: (iid: string, p: Partial<SymState>) => void;
  setNets: (n: SchNet[] | null) => void;
  setZoom: (z: number) => void;
  setPan: (p: { x: number; y: number }) => void;
  reset: () => void;
}

export const useSchematicStore = create<SchematicState>((set) => ({
  pos: {},
  nets: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  setPos: (iid, p) => set((s) => {
    const base = s.pos[iid] ?? { x: 0, y: 0, rotation: 0 };
    return { pos: { ...s.pos, [iid]: { ...base, ...p } } };
  }),
  setNets: (n) => set({ nets: n }),
  setZoom: (z) => set({ zoom: z }),
  setPan: (p) => set({ pan: p }),
  reset: () => set({ pos: {}, nets: null }),
}));

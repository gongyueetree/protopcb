/**
 * state/pcbViewStore.ts
 * PCB 画布的**视图状态** —— 显示模式、3D 显隐、视口。
 *
 * 刻意不放进 CircuitCanvasDocument：
 *   "我暂时把 U3 的 3D 藏起来看焊盘" 不是工程事实，
 *   它不该进版本号、不该进 BOM、不该进导出、不该进 undo/redo。
 *   混进文档的后果是每次切个视图都把设计标记成"已修改"。
 */
import { create } from 'zustand';

export type PcbVisualMode = '2d' | 'hybrid' | 'realistic';

export interface PcbViewport { zoom: number; panX: number; panY: number }

interface PcbViewState {
  mode: PcbVisualMode;
  /** 焊盘/封装外框/器件3D 的总开关 */
  showPads: boolean;
  showFootprintBody: boolean;
  showComponent3D: boolean;
  projectionOpacity: number;
  /** 单独隐藏的器件（会话内有效，不持久化） */
  hidden3dIds: Record<string, true>;
  /** 只看这一个器件的 3D */
  solo3dId: string | null;
  /** 与 2D 画布共享的视口（由 BoardCanvas2D 写入，投影层只读） */
  viewport: PcbViewport;

  setMode: (mode: PcbVisualMode) => void;
  setViewport: (vp: PcbViewport) => void;
  setShowPads: (v: boolean) => void;
  setShowFootprintBody: (v: boolean) => void;
  setShowComponent3D: (v: boolean) => void;
  toggleComponent3D: (instanceId: string) => void;
  hideComponent3D: (instanceId: string) => void;
  revealComponent3D: (instanceId: string) => void;
  showAll3D: () => void;
  hideAll3D: (allIds: string[]) => void;
  soloComponent3D: (instanceId: string) => void;
  clearSolo3D: () => void;
  resetViewOptions: () => void;
  /** 某个器件此刻是否应该渲染 3D（solo 优先于单独隐藏） */
  is3DVisible: (instanceId: string) => boolean;
}

const MODE_KEY = 'cc_pcb_visual_mode';
const loadMode = (): PcbVisualMode => {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'hybrid' || v === 'realistic' || v === '2d' ? v : '2d';
  } catch { return '2d'; }
};

export const usePcbViewStore = create<PcbViewState>((set, get) => ({
  mode: loadMode(),
  showPads: true,
  showFootprintBody: true,
  showComponent3D: true,
  projectionOpacity: 1,
  hidden3dIds: {},
  solo3dId: null,
  viewport: { zoom: 1, panX: 0, panY: 0 },

  setMode: (mode) => {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* 隐私模式等 */ }
    set({ mode });
  },
  setViewport: (viewport) => set({ viewport }),
  setShowPads: (showPads) => set({ showPads }),
  setShowFootprintBody: (showFootprintBody) => set({ showFootprintBody }),
  setShowComponent3D: (showComponent3D) => set({ showComponent3D }),

  toggleComponent3D: (id) => set((s) => {
    const next = { ...s.hidden3dIds };
    if (next[id]) delete next[id]; else next[id] = true;
    // 单独操作某个器件时退出 solo，否则用户会觉得按钮"没反应"
    return { hidden3dIds: next, solo3dId: s.solo3dId === id ? null : s.solo3dId };
  }),
  hideComponent3D: (id) => set((s) => ({ hidden3dIds: { ...s.hidden3dIds, [id]: true } })),
  revealComponent3D: (id) => set((s) => {
    const next = { ...s.hidden3dIds };
    delete next[id];
    return { hidden3dIds: next };
  }),
  showAll3D: () => set({ hidden3dIds: {}, solo3dId: null, showComponent3D: true }),
  hideAll3D: (allIds) => set({
    hidden3dIds: Object.fromEntries(allIds.map((id) => [id, true as const])),
    solo3dId: null,
  }),
  soloComponent3D: (id) => set({ solo3dId: id, showComponent3D: true }),
  clearSolo3D: () => set({ solo3dId: null }),
  resetViewOptions: () => set({
    showPads: true, showFootprintBody: true, showComponent3D: true,
    hidden3dIds: {}, solo3dId: null, projectionOpacity: 1,
  }),

  is3DVisible: (id) => {
    const s = get();
    if (!s.showComponent3D) return false;
    if (s.solo3dId) return s.solo3dId === id;
    return !s.hidden3dIds[id];
  },
}));

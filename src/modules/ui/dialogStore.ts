/**
 * modules/ui/dialogStore.ts
 * 统一的非阻塞对话框与提示（替代 window.alert / confirm / prompt）。
 *
 * 阻塞式浏览器弹窗的问题：打断渲染循环（3D 视图会卡住）、样式不可控、不能 i18n 排版、
 * 在 iframe/嵌入场景可能被宿主直接禁掉。这里用 Promise 形式提供同样的语义：
 *   toast(message, tone)          非阻塞提示，几秒后自动消失
 *   confirm(message)  → Promise<boolean>
 *   prompt(message, defaultValue) → Promise<string | null>
 */
import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';
export interface Toast { id: number; message: string; tone: ToastTone }

interface DialogRequest {
  id: number;
  kind: 'confirm' | 'prompt';
  title?: string;
  message: string;
  defaultValue?: string;
  /** 输入校验：返回错误文案则不允许提交 */
  validate?: (v: string) => string | null;
  resolve: (v: string | boolean | null) => void;
}

interface DialogState {
  toasts: Toast[];
  dialog: DialogRequest | null;
  toast: (message: string, tone?: ToastTone, ms?: number) => void;
  confirm: (message: string, title?: string) => Promise<boolean>;
  prompt: (message: string, defaultValue?: string, opts?: { title?: string; validate?: (v: string) => string | null }) => Promise<string | null>;
  /** 由对话框组件调用 */
  resolveDialog: (v: string | boolean | null) => void;
  dismissToast: (id: number) => void;
}

let seq = 0;

export const useDialogStore = create<DialogState>((set, get) => ({
  toasts: [],
  dialog: null,
  toast: (message, tone = 'info', ms = 4000) => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
    setTimeout(() => get().dismissToast(id), ms);
  },
  confirm: (message, title) => new Promise<boolean>((resolve) => {
    set({ dialog: { id: ++seq, kind: 'confirm', title, message, resolve: (v) => resolve(v === true) } });
  }),
  prompt: (message, defaultValue = '', opts) => new Promise<string | null>((resolve) => {
    set({ dialog: { id: ++seq, kind: 'prompt', title: opts?.title, message, defaultValue, validate: opts?.validate, resolve: (v) => resolve(typeof v === 'string' ? v : null) } });
  }),
  resolveDialog: (v) => {
    const d = get().dialog;
    if (!d) return;
    set({ dialog: null });
    d.resolve(v);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 便捷函数（非 React 代码也能用） */
export const dialogs = {
  toast: (m: string, tone?: ToastTone) => useDialogStore.getState().toast(m, tone),
  confirm: (m: string, title?: string) => useDialogStore.getState().confirm(m, title),
  prompt: (m: string, d?: string, opts?: { title?: string; validate?: (v: string) => string | null }) => useDialogStore.getState().prompt(m, d, opts),
};

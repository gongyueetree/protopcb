/**
 * state/libFileStore.ts
 * 库注册表版本号的 React 订阅（zustand）。
 * 真值在 design-core/geometry/lib-file-registry（框架无关）；这里只是把它的变更桥接成 hook，
 * 让依赖 Domain 的组件在库文件加载完成后重渲染。
 */
import { create } from 'zustand';
import { libRegistryVersion, subscribeLibRegistry } from '../design-core/geometry/lib-file-registry';

interface LibFileState { version: number; bump: () => void }

export const useLibFileStore = create<LibFileState>((set) => ({
  version: libRegistryVersion(),
  bump: () => set({ version: libRegistryVersion() }),
}));

// 订阅 Domain 的版本变更 → 同步到 store（模块级一次订阅即可）。
// ⚠ 这里必须是 store.bump()（只读取当前版本写进 store），绝不能是 bumpLibRegistry()：
//   后者会再次触发本订阅 → 无限递归（Maximum call stack size exceeded）。踩过一次。
subscribeLibRegistry(() => useLibFileStore.getState().bump());

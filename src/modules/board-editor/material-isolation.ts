/**
 * modules/board-editor/material-isolation.ts
 * 视图私有材质隔离。
 *
 * 背景：stepModelFor() 返回的是缓存模型的 clone，但 Three.js 的 clone()
 * **共享 geometry 与 material**。投影层为了做透明度而改 material.opacity，
 * 会连带改掉 3D 全视图里同一颗料、以及 STEP 缓存本身 —— 一个视图的显示设置
 * 污染另一个视图，且难以复现。
 *
 * 规则：geometry 可以共享（省内存，且我们从不改它）；
 * material 必须按实例克隆后再改。
 */
import type * as THREE from 'three';

interface MeshLike {
  material?: THREE.Material | THREE.Material[];
  traverse(cb: (o: MeshLike) => void): void;
}

/** 把对象树里所有材质换成本实例私有的克隆；返回克隆的材质数量 */
export function cloneMaterialsForView(root: MeshLike): number {
  let n = 0;
  root.traverse((o) => {
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) {
      o.material = m.map((x) => { n++; return x.clone(); });
    } else {
      o.material = m.clone();
      n++;
    }
  });
  return n;
}

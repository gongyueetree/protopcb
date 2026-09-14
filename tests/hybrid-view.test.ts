/**
 * Hybrid 视图：显隐语义、材质隔离、增量重建
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { usePcbViewStore } from '../src/state/pcbViewStore';
import { cloneMaterialsForView } from '../src/modules/board-editor/material-isolation';
import { modelKey } from '../src/modules/board-editor/PcbProjection3DLayer';
import { searchResultToPlaced } from '../src/design-core/document/services';
import type { ComponentSearchResult } from '../src/providers/types';

const comp = (ref: string, stepUrl?: string) => {
  const c = searchResultToPlaced({
    componentId: 'x' + ref, mpn: 'M', manufacturer: '-', category: 'ic',
    defaultFootprintName: 'SOIC-8_3.9x4.9mm_P1.27mm', family: 'IC', pins: 8,
  } as ComponentSearchResult, ref);
  if (stepUrl) c.display = { ...(c.display ?? {}), stepUrl };
  return c;
};

describe('显隐语义（§18）', () => {
  beforeEach(() => usePcbViewStore.getState().resetViewOptions());
  const st = () => usePcbViewStore.getState();

  it('隐藏全部后新增的器件仍然是隐藏的（不再枚举当前 id）', () => {
    st().hideAll3D();
    expect(st().is3DVisible('existing')).toBe(false);
    expect(st().is3DVisible('brand-new-component')).toBe(false);   // 之后才添加的器件
  });

  it('显示全部恢复', () => {
    st().hideAll3D();
    st().showAll3D();
    expect(st().is3DVisible('any')).toBe(true);
  });

  it('solo 状态下操作**别的**器件也会退出 solo', () => {
    st().soloComponent3D('U1');
    expect(st().solo3dId).toBe('U1');
    st().toggleComponent3D('U2');
    expect(st().solo3dId).toBeNull();
  });

  it('单件隐藏/显示都退出 solo', () => {
    st().soloComponent3D('U1');
    st().hideComponent3D('U3');
    expect(st().solo3dId).toBeNull();
    st().soloComponent3D('U1');
    st().revealComponent3D('U3');
    expect(st().solo3dId).toBeNull();
  });
});

describe('材质隔离（§16）', () => {
  it('克隆后改透明度不影响原材质（否则会污染 3D 全视图与 STEP 缓存）', () => {
    const shared = new THREE.MeshStandardMaterial({ color: 0x336699 });
    const cached = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
    cached.add(mesh);

    const viewCopy = cached.clone();                    // Three 的 clone 共享材质
    expect((viewCopy.children[0] as THREE.Mesh).material).toBe(shared);

    const n = cloneMaterialsForView(viewCopy as never);
    expect(n).toBeGreaterThan(0);
    const viewMat = (viewCopy.children[0] as THREE.Mesh).material as THREE.Material;
    expect(viewMat).not.toBe(shared);

    viewMat.transparent = true;
    viewMat.opacity = 0.3;
    expect(shared.opacity).toBe(1);                     // 原材质纹丝不动
    expect(shared.transparent).toBe(false);
  });

  it('材质数组同样逐个克隆', () => {
    const a = new THREE.MeshStandardMaterial(), b = new THREE.MeshStandardMaterial();
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [a, b]));
    cloneMaterialsForView(g as never);
    const mats = (g.children[0] as THREE.Mesh).material as THREE.Material[];
    expect(mats[0]).not.toBe(a);
    expect(mats[1]).not.toBe(b);
  });

  it('geometry 仍然共享（省内存，且我们从不改它）', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
    cloneMaterialsForView(g as never);
    expect((g.children[0] as THREE.Mesh).geometry).toBe(geo);
  });
});

describe('增量重建（§17）', () => {
  it('modelKey 不含全局版本号：别的器件 STEP 加载完不会让本器件重建', () => {
    const c = comp('U1');
    const before = modelKey(c, '-');
    const after = modelKey(c, '-');          // 别处 libVersion++ 与本 key 无关
    expect(after).toBe(before);
  });

  it('本器件的 STEP 状态变化才触发重建', () => {
    const c = comp('U2', 'https://x/y.step');
    expect(modelKey(c, 'loading')).not.toBe(modelKey(c, 'ready'));
  });

  it('换封装触发重建', () => {
    const a = comp('U3');
    const b = comp('U3');
    b.footprint = { ...b.footprint, name: 'QFN-16-1EP_3x3mm_P0.5mm' };
    expect(modelKey(a, '-')).not.toBe(modelKey(b, '-'));
  });

  it('100 个器件里只有 1 个 STEP 就绪时，只有它的 key 变化', () => {
    const comps = Array.from({ length: 100 }, (_, i) => comp('U' + i, i === 42 ? 'https://x/42.step' : undefined));
    const before = comps.map((c) => modelKey(c, c.display?.stepUrl ? 'loading' : '-'));
    const after = comps.map((c) => modelKey(c, c.display?.stepUrl ? 'ready' : '-'));
    const changed = before.filter((k, i) => k !== after[i]).length;
    expect(changed).toBe(1);
  });
});

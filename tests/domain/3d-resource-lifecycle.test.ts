/**
 * Phase 18：3D 资源生命周期 —— 真实行为测试，不扫源码
 *   1) 视图 dispose 不碰 STEP 缓存的共享资源
 *   2) 工程自带 STEP 的 blob URL 有登记与撤销
 *   3) 位号开关：showRefDes=false 时贴图渲染器真的不画位号
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
}

describe('视图 dispose 只释放自有资源', () => {
  it('带 sharedResource 标记的 mesh 的 geometry/material 不被 dispose', async () => {
    const { disposeViewOwned } = await import('../../src/modules/board-editor/BoardView3D');
    const sharedGeo = new THREE.BoxGeometry(1, 1, 1);
    const sharedMat = new THREE.MeshStandardMaterial();
    const ownGeo = new THREE.BoxGeometry(1, 1, 1);
    const g = new THREE.Group();
    const shared = new THREE.Mesh(sharedGeo, sharedMat); shared.userData.sharedResource = true;
    const own = new THREE.Mesh(ownGeo, new THREE.MeshStandardMaterial());
    g.add(shared, own);
    const spyShared = vi.spyOn(sharedGeo, 'dispose');
    const spyOwn = vi.spyOn(ownGeo, 'dispose');
    disposeViewOwned(g);
    expect(spyShared).not.toHaveBeenCalled();
    expect(spyOwn).toHaveBeenCalledTimes(1);
  });

});

describe('工程自带 STEP 的 blob 生命周期', () => {
  let created: string[]; let revoked: string[];
  beforeEach(() => {
    created = []; revoked = [];
    let n = 0;
    vi.stubGlobal('URL', {
      createObjectURL: () => { const u = `blob:test/${++n}`; created.push(u); return u; },
      revokeObjectURL: (u: string) => { revoked.push(u); },
    });
    vi.stubGlobal('Blob', class { constructor(public parts: unknown[]) {} });
  });

  it('同一资产键复用同一个 blob（多个实例共享，不重复创建）', async () => {
    const reg = await import('../../src/infrastructure/model-assets');
    const u1 = reg.registerModelBlob('altium:MODEL-A', new Uint8Array([1]));
    const u2 = reg.registerModelBlob('altium:MODEL-A', new Uint8Array([1]));   // 第二个实例用同一模型
    expect(u2).toBe(u1);
    expect(created.length).toBe(1);
    // 不同资产各自一个
    reg.registerModelBlob('altium:MODEL-B', new Uint8Array([2]));
    expect(reg.__modelBlobCount()).toBe(2);
    const n = reg.revokeAllModelBlobs();
    expect(n).toBe(2);
    expect(reg.__modelBlobCount()).toBe(0);
    expect(revoked.length).toBe(2);
  });

  it('撤销时把 STEP 缓存里对应的模型一并驱逐（不再残留死 URL 的模型）', async () => {
    const reg = await import('../../src/infrastructure/model-assets');
    const loader = await import('../../src/modules/board-editor/step-loader');
    const evict = vi.spyOn(loader, 'evictStepModel');
    const u = reg.registerModelBlob('X', new Uint8Array([1]));
    reg.revokeModelBlob(u);
    expect(evict).toHaveBeenCalledWith(u);
  });
});

describe('位号开关只影响贴图内容', () => {
  it('showRefDes=false 时贴图渲染器不调用 fillText 画位号', async () => {
    const fillText = vi.fn();
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'fillText' ? fillText : k === 'canvas' ? { width: 10, height: 10 } : () => undefined) });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
    const { buildBoardTexture } = await import('../../src/modules/board-editor/board-texture');
    const { createDocument } = await import('../../src/design-core/document/factory');
    const { searchResultToPlaced } = await import('../../src/design-core/document/services');
    const doc = createDocument({ name: 't' });
    doc.components.push(searchResultToPlaced({ componentId: 'k', mpn: 'X', manufacturer: '-', category: 'ic', defaultFootprintName: 'SOIC-8_3.9x4.9mm_P1.27mm', family: 'IC', description: '', pins: 8 }, 'U1'));

    buildBoardTexture(doc, 'top', { showRefDes: true });
    const withRef = fillText.mock.calls.filter((c) => c[0] === 'U1').length;
    fillText.mockClear();
    buildBoardTexture(doc, 'top', { showRefDes: false });
    const withoutRef = fillText.mock.calls.filter((c) => c[0] === 'U1').length;

    expect(withRef).toBeGreaterThan(0);
    expect(withoutRef).toBe(0);
  });
});

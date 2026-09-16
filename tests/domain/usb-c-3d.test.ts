/**
 * USB-C 3D：壳体与开口必须朝同一个方向（此前壳体在 -z、舌片在 +z，看起来转了 180°）
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildComponent3D } from '../../src/modules/board-editor/footprint3d';
import { searchResultToPlaced } from '../../src/design-core/document/services';

const usb = () => buildComponent3D(searchResultToPlaced({
  componentId: 'k', mpn: 'USB-C-16P', manufacturer: '-', category: 'connector',
  defaultFootprintName: 'USB_C_Receptacle_USB2.0_16P', family: 'Connector', description: '', pins: 16,
}, 'J1'));

describe('USB-C 朝向', () => {
  it('壳体以封装原点居中（不是整体偏向一侧）', () => {
    const g = usb();
    const shell = g.children[0] as THREE.Mesh;
    const b = new THREE.Box3().setFromObject(shell);
    expect(Math.abs((b.min.z + b.max.z) / 2)).toBeLessThan(0.6);
    expect(b.max.z - b.min.z).toBeCloseTo(7, 0);
  });

  it('舌片与内衬落在壳体内部（开口与壳体同向）', () => {
    const g = usb();
    const shellBox = new THREE.Box3().setFromObject(g.children[0]);
    for (const idx of [1, 2]) {
      const part = new THREE.Box3().setFromObject(g.children[idx]);
      expect(part.min.z).toBeGreaterThanOrEqual(shellBox.min.z - 0.01);
      expect(part.max.z).toBeLessThanOrEqual(shellBox.max.z + 0.01);
    }
  });

  it('整体高度合理（贴板，不是立起来的柱子）', () => {
    const b = new THREE.Box3().setFromObject(usb());
    expect(b.max.y).toBeLessThan(4);
    expect(b.min.y).toBeGreaterThanOrEqual(-0.001);   // 浮点误差
  });
});

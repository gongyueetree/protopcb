/**
 * 排针 3D：必须按真实焊盘建模，不能按封装名里的 1x12 猜方向
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildComponent3D } from '../../src/modules/board-editor/footprint3d';
import { registerFootprintOverride } from '../../src/design-core/geometry/lib-file-registry';
import { searchResultToPlaced } from '../../src/design-core/document/services';
import type { ComponentSearchResult } from '../../src/providers/types';

/** KiCad 的 1x12 排针：焊盘沿 Y 排成一列（不是沿 X） */
registerFootprintOverride('PinHeader_1x12_P2.54mm_Vertical', {
  bodyW: 2.54, bodyH: 30.48,
  pads: Array.from({ length: 12 }, (_, i) => ({ x: 0, y: i * 2.54, w: 1.7, h: 1.7, num: String(i + 1), round: true })),
});
/** 卧式排针：本体整体偏到一侧 */
registerFootprintOverride('PinHeader_1x04_P2.54mm_Horizontal', {
  bodyW: 8, bodyH: 10.16, bodyCx: 5,
  pads: Array.from({ length: 4 }, (_, i) => ({ x: 0, y: i * 2.54, w: 1.7, h: 1.7, num: String(i + 1), round: true })),
});

const mk = (fp: string) => searchResultToPlaced({
  componentId: 'x', mpn: 'HDR', manufacturer: '-', category: 'connector',
  defaultFootprintName: fp, family: 'Header', pins: 12,
} as ComponentSearchResult, 'J1');

const bbox = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o);

describe('排针 3D 与焊盘对齐', () => {
  it('1x12 沿 Y 展开，不是沿 X（此前整体转了 90°）', () => {
    const b = bbox(buildComponent3D(mk('PinHeader_1x12_P2.54mm_Vertical')));
    const sizeX = b.max.x - b.min.x, sizeZ = b.max.z - b.min.z;
    expect(sizeZ).toBeGreaterThan(25);      // 12 × 2.54 ≈ 28mm 在 Z（板坐标 y）方向
    expect(sizeX).toBeLessThan(5);          // X 方向只有一排
  });

  it('引脚落在每个焊盘的真实位置上', () => {
    const g = buildComponent3D(mk('PinHeader_1x12_P2.54mm_Vertical'));
    const b = bbox(g);
    // 焊盘 y 从 0 到 27.94，模型中心应在 13.97 附近
    expect((b.min.z + b.max.z) / 2).toBeCloseTo(13.97, 0);
    expect(Math.abs((b.min.x + b.max.x) / 2)).toBeLessThan(1);
  });

  it('卧式排针的本体偏移不影响引脚对齐（引脚仍在焊盘列上）', () => {
    const g = buildComponent3D(mk('PinHeader_1x04_P2.54mm_Horizontal'));
    const pins = g.children.filter((o) => (o as THREE.Mesh).geometry instanceof THREE.BoxGeometry).slice(1);
    for (const p of pins) expect(Math.abs(p.position.x)).toBeLessThan(0.01);
  });
});

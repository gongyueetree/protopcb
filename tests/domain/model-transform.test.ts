/**
 * .kicad_pcb 的 (model offset/rotate/scale) 必须被应用。
 * 真实案例：USB-C 带 (rotate 180 0 0)（不应用就整个翻过来），
 * 轻触开关带 (rotate -90 0 0)（不应用就立着而不是躺平）。
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parseKicadPcb } from '../../src/design-core/geometry/kicad-pcb-import';
import { applyModelTransform } from '../../src/modules/board-editor/footprint3d';

const PCB = `(kicad_pcb (version 20240108) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (footprint "Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12" (layer "F.Cu") (at 10 10)
    (property "Reference" "J3" (at 0 0 0)) (property "Value" "USB_C" (at 0 2 0))
    (pad "A1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
    (model "\${KIPRJMOD}/Lib/USB Type C Port (SMD Type).STEP"
      (offset (xyz 0 3.5 1.5)) (scale (xyz 1 1 1)) (rotate (xyz 180 0 0))))
  (footprint "Button_Switch_SMD:SW_SPST_EVQP7C" (layer "F.Cu") (at 30 10)
    (property "Reference" "SW1" (at 0 0 0)) (property "Value" "BOOT" (at 0 2 0))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
    (model "\${KIPRJMOD}/Lib/EVQP7-MD-01P.STEP"
      (offset (xyz 0.3 -0.2 0)) (scale (xyz 1 1 1)) (rotate (xyz -90 0 0))))
  (footprint "Resistor_SMD:R_0402_1005Metric" (layer "F.Cu") (at 50 10)
    (property "Reference" "R1" (at 0 0 0)) (property "Value" "10k" (at 0 2 0))
    (pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Cu"))
    (model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step"
      (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))))`;

describe('解析 (model) 变换', () => {
  const r = parseKicadPcb(PCB);
  it('带旋转/偏移的封装被记录', () => {
    expect(r.modelTransforms['USB_C_Receptacle_HRO_TYPE-C-31-M-12']).toEqual({
      offset: [0, 3.5, 1.5], rotate: [180, 0, 0], scale: [1, 1, 1],
    });
    expect(r.modelTransforms['SW_SPST_EVQP7C'].rotate).toEqual([-90, 0, 0]);
  });
  it('全是单位变换的不记录（省得每个器件都挂一份无用数据）', () => {
    expect(r.modelTransforms['R_0402_1005Metric']).toBeUndefined();
  });
});

describe('应用变换', () => {
  const boxOf = (t?: Parameters<typeof applyModelTransform>[1]) => {
    const g = new THREE.Group();
    // 一个明显不对称的形体：沿 +Y 方向长，便于看出翻转
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 6, 2));
    m.position.set(0, 3, 0);
    g.add(m);
    const out = applyModelTransform(g, t);
    out.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(out);
  };

  it('无变换时原样返回', () => {
    const b = boxOf(undefined);
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(6, 5);
  });

  it('rotate 180° 绕 X：形体翻到另一侧（USB-C 的那个 180）', () => {
    const b = boxOf({ rotate: [180, 0, 0] });
    expect(b.max.y).toBeLessThan(0.01);      // 原本朝上，翻转后朝下
    expect(b.min.y).toBeCloseTo(-6, 4);
  });

  it('rotate -90° 绕 X：立着的形体躺平（轻触开关的那个 -90）', () => {
    const b = boxOf({ rotate: [-90, 0, 0] });
    expect(b.max.y - b.min.y).toBeCloseTo(2, 4);     // 高度从 6 变成 2
    expect(b.max.z - b.min.z).toBeCloseTo(6, 4);     // 长度转到板面内
  });

  it('offset 按 KiCad 坐标系换算（y_kicad → z_scene，取负）', () => {
    const b = boxOf({ offset: [1, 3.5, 1.5] });
    expect(b.min.x).toBeCloseTo(0, 4);               // -1 + 1
    expect((b.min.z + b.max.z) / 2).toBeCloseTo(-3.5, 4);
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(3 + 1.5, 4);
  });
});

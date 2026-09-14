/**
 * 层级原理图与工程自带 3D 模型（用真实工程 Openscope_RP2040 的结构验证）
 */
import { describe, it, expect } from 'vitest';
import { parseKicadSch } from '../src/design-core/geometry/kicad-sch-import';
import { parseKicadPcb } from '../src/design-core/geometry/kicad-pcb-import';

const ROOT = `(kicad_sch (version 20231120) (generator eeschema)
  (paper "A4")
  (lib_symbols)
  (sheet (at 50.8 38.1) (size 25.4 15.24)
    (property "Sheetname" "MAX1193" (at 50.8 37.4 0))
    (property "Sheetfile" "max1193.kicad_sch" (at 50.8 53.9 0))
    (pin "ADC_CLK" input (at 50.8 40.64 180))
    (pin "ADC_D7" output (at 76.2 43.18 0))
  )
  (sheet (at 100 38.1) (size 25.4 15.24)
    (property "Sheetname" "Scope AFE1" (at 100 37.4 0))
    (property "Sheetfile" "scope_afe.kicad_sch" (at 100 53.9 0))
  )
  (sheet (at 100 70) (size 25.4 15.24)
    (property "Sheetname" "Scope AFE2" (at 100 69.4 0))
    (property "Sheetfile" "scope_afe.kicad_sch" (at 100 85.9 0))
  )
)`;
const CHILD = `(kicad_sch (version 20231120) (generator eeschema)
  (lib_symbols)
  (hierarchical_label "ADC_CLK" (shape input) (at 60.96 66.04 180))
  (hierarchical_label "ADC_D7" (shape output) (at 120.65 55.88 0))
  (global_label "+3V0" (shape input) (at 80 20 0))
  (label "local_net" (at 30 30 0))
)`;

describe('层级页框解析（父页）', () => {
  const r = parseKicadSch(ROOT);
  it('解析出 3 个子页框，含名字/文件/尺寸', () => {
    expect(r.sheets).toHaveLength(3);
    expect(r.sheets[0]).toMatchObject({ name: 'MAX1193', file: 'max1193.kicad_sch', x: 50.8, y: 38.1, w: 25.4, h: 15.24 });
  });
  it('页框管脚（与子页层级标签对接）', () => {
    expect(r.sheets[0].pins.map((p) => p.name)).toEqual(['ADC_CLK', 'ADC_D7']);
    expect(r.sheets[0].pins[0].shape).toBe('input');
  });
  it('同一文件可被多个页框复用（Scope AFE1/2）', () => {
    expect(r.sheets.filter((s) => s.file === 'scope_afe.kicad_sch')).toHaveLength(2);
  });
});

describe('层级标签解析（子页）', () => {
  const r = parseKicadSch(CHILD);
  it('hierarchical / global / local 三类都保留，并带 kind', () => {
    const byKind = (k: string) => r.labels.filter((l) => l.kind === k).map((l) => l.text);
    expect(byKind('hierarchical')).toEqual(['ADC_CLK', 'ADC_D7']);
    expect(byKind('global')).toEqual(['+3V0']);
    expect(byKind('local')).toEqual(['local_net']);
  });
  it('层级标签的 shape 与父页管脚方向一致', () => {
    expect(r.labels.find((l) => l.text === 'ADC_CLK')!.shape).toBe('input');
  });
});

describe('工程自带 3D 模型路径', () => {
  const PCB = `(kicad_pcb (version 20240108) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (footprint "Button_Switch_SMD:SW_Push_1P1T_NO_Vertical" (layer "F.Cu") (at 20 20)
    (property "Reference" "SW1" (at 0 0 0)) (property "Value" "SW" (at 0 2 0))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
    (model "\${KIPRJMOD}/3D/evqp7-ja-01p.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
  )
  (footprint "Connector_PinHeader:PinHeader_1x3-P2.54-horizontal" (layer "F.Cu") (at 40 20)
    (property "Reference" "J3" (at 0 0 0)) (property "Value" "DEBUG" (at 0 2 0))
    (pad "1" thru_hole circle (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu"))
    (model "\${KIPRJMOD}/3D/DS1025 (PLS-03T CONNFLY).stp" (offset (xyz 0 0 0)))
  )
  (footprint "Resistor_SMD:R_0402_1005Metric" (layer "F.Cu") (at 60 20)
    (property "Reference" "R1" (at 0 0 0)) (property "Value" "10k" (at 0 2 0))
    (pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Cu"))
    (model "\${KICAD8_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl")
  ))`;
  const r = parseKicadPcb(PCB);
  it('记录工程相对路径（含空格与括号的文件名也保留）', () => {
    expect(r.projectModelPaths['SW_Push_1P1T_NO_Vertical']).toBe('${KIPRJMOD}/3D/evqp7-ja-01p.step');
    expect(r.projectModelPaths['PinHeader_1x3-P2.54-horizontal']).toBe('${KIPRJMOD}/3D/DS1025 (PLS-03T CONNFLY).stp');
  });
  it('官方库 .3dshapes 引用不进工程模型表（那条走 KiCad 官方 3D）', () => {
    expect(r.projectModelPaths['R_0402_1005Metric']).toBeUndefined();
    const r2 = parseKicadPcb(PCB.replace('R_0402_1005Metric.wrl', 'R_0402_1005Metric.step'));
    expect(r2.projectModelPaths['R_0402_1005Metric']).toBeUndefined();
    expect(r.modelRefs['R_0402_1005Metric']).toMatchObject({ lib3d: 'Resistor_SMD', name3d: 'R_0402_1005Metric' });
  });
  it('按文件名（忽略目录与大小写）就能在 zip 里匹配到', () => {
    const zipNames = ['Openscope_RP2040/3D/evqp7-ja-01p.step', 'Openscope_RP2040/3D/DS1025 (PLS-03T CONNFLY).stp', 'Openscope_RP2040/3D/DSS0012B.stp'];
    const base = (p: string) => p.split(/[\\/]/).pop()!.toLowerCase();
    for (const mpath of Object.values(r.projectModelPaths)) {
      expect(zipNames.some((n) => base(n) === base(mpath))).toBe(true);
    }
  });
});

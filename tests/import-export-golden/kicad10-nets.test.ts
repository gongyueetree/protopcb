/**
 * KiCad 10（version 20260206+）取消了顶层 (net N "name") 编号表，pad/segment 里只写 (net "name")。
 * 按旧格式解析会一个网络都认不出来 —— 导入的板每个器件都显示"没有网络连接数据"（真实回归）。
 */
import { describe, it, expect } from 'vitest';
import { parseKicadPcb } from '../../src/design-core/geometry/kicad-pcb-import';

const KICAD10 = `(kicad_pcb (version 20260206) (generator pcbnew) (generator_version "10.0")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 10 10)
    (property "Reference" "R1" (at 0 0 0)) (property "Value" "10k" (at 0 2 0))
    (pad "1" smd roundrect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu") (net "+3V3"))
    (pad "2" smd roundrect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu") (net "Net-(R1-Pad2)")))
  (footprint "Capacitor_SMD:C_0402_1005Metric" (layer "F.Cu") (at 20 10)
    (property "Reference" "C1" (at 0 0 0)) (property "Value" "100nF" (at 0 2 0))
    (pad "1" smd roundrect (at -0.5 0) (size 0.6 0.6) (layers "F.Cu") (net "+3V3"))
    (pad "2" smd roundrect (at 0.5 0) (size 0.6 0.6) (layers "F.Cu") (net "GND")))
  (segment (start 10 10) (end 20 10) (width 0.2) (layer "F.Cu") (net "+3V3")))`;

const KICAD9 = `(kicad_pcb (version 20240108) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "+3V3")
  (net 2 "GND")
  (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 10 10)
    (property "Reference" "R1" (at 0 0 0)) (property "Value" "10k" (at 0 2 0))
    (pad "1" smd roundrect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu") (net 1 "+3V3"))
    (pad "2" smd roundrect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu") (net 2 "GND")))
  (segment (start 10 10) (end 20 10) (width 0.2) (layer "F.Cu") (net 1)))`;

describe('KiCad 10：pad 里只有网络名', () => {
  const r = parseKicadPcb(KICAD10);
  it('网络被识别并自行编号', () => {
    const names = Object.values(r.nets ?? {});
    expect(names).toContain('+3V3');
    expect(names).toContain('GND');
    expect(names).toContain('Net-(R1-Pad2)');
  });
  it('每个器件都有 padNets（此前全是 undefined）', () => {
    expect(r.comps.every((c) => c.padNets && Object.keys(c.padNets).length > 0)).toBe(true);
  });
  it('同名网络在不同器件上编号一致（R1.1 与 C1.1 都是 +3V3）', () => {
    const r1 = r.comps.find((c) => c.reference === 'R1')!;
    const c1 = r.comps.find((c) => c.reference === 'C1')!;
    expect(r1.padNets!['1']).toBe(c1.padNets!['1']);
    expect(r1.padNets!['2']).not.toBe(c1.padNets!['2']);
  });
  it('走线也带网络', () => {
    expect(r.tracks.every((t) => t.net != null)).toBe(true);
  });
});

describe('KiCad ≤9 的编号表格式不受影响', () => {
  const r = parseKicadPcb(KICAD9);
  it('沿用文件里的编号', () => {
    expect(r.nets![1]).toBe('+3V3');
    expect(r.nets![2]).toBe('GND');
    const r1 = r.comps.find((c) => c.reference === 'R1')!;
    expect(r1.padNets).toEqual({ '1': 1, '2': 2 });
  });
});

describe('同名封装几何冲突不被静默吞掉', () => {
  const mk = (ref: string, dy: number) => `  (footprint "Lib:SOIC-8" (layer "F.Cu") (at ${ref === 'U1' ? 10 : 30} 10)
    (property "Reference" "${ref}" (at 0 0 0)) (property "Value" "X" (at 0 2 0))
    (pad "1" smd rect (at -2 ${-dy}) (size 1 0.4) (layers "F.Cu"))
    (pad "2" smd rect (at -2 ${dy}) (size 1 0.4) (layers "F.Cu")))`;
  const head = `(kicad_pcb (version 20240108) (generator pcbnew)
  (general (thickness 1.6)) (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user)) (net 0 "")`;

  it('几何一致时不报冲突', () => {
    const r = parseKicadPcb(`${head}\n${mk('U1', 0.65)}\n${mk('U2', 0.65)})`);
    expect(r.footprintConflicts).toEqual([]);
  });

  it('实例改过焊盘时记录冲突（保留首个，如实告知）', () => {
    const r = parseKicadPcb(`${head}\n${mk('U1', 0.65)}\n${mk('U2', 1.27)})`);
    expect(r.footprintConflicts).toHaveLength(1);
    expect(r.footprintConflicts[0]).toMatchObject({ footprintName: 'SOIC-8', references: ['U2'], kept: 'first' });
    // 保留的是首个实例的几何
    expect(r.footprintDefs['SOIC-8'].pads.map((p) => p.y).sort()).toEqual([-0.65, 0.65]);
  });
});

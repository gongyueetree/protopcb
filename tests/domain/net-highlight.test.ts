/**
 * iBOM 式网络高亮联动回归
 * 数据链路：padNets / track.net → 选中网络 → 侧栏节点列表
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useDesignStore } from '../../src/state/designStore';
import { parseKicadPcb } from '../../src/design-core/geometry/kicad-pcb-import';

const PCB = `(kicad_pcb (version 20221018)
  (net 0 "")
  (net 1 "GND")
  (net 2 "+3V3")
  (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts") (width 0.05))
  (segment (start 5 5) (end 15 5) (width 0.25) (layer "F.Cu") (net 2))
  (segment (start 5 8) (end 15 8) (width 0.25) (layer "F.Cu") (net 1))
  (via (at 15 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2))
  (footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" (layer "F.Cu") (at 10 15)
    (property "Reference" "U1")
    (property "Value" "LM358")
    (pad "1" smd rect (at -2.7 -1.9) (size 1.5 0.6) (layers "F.Cu") (net 2 "+3V3"))
    (pad "4" smd rect (at -2.7 1.9) (size 1.5 0.6) (layers "F.Cu") (net 1 "GND"))
  )
  (footprint "Resistor_SMD:R_0402_1005Metric" (layer "F.Cu") (at 20 15)
    (property "Reference" "R1")
    (property "Value" "10K")
    (pad "1" smd rect (at -0.5 0) (size 0.6 0.5) (layers "F.Cu") (net 2 "+3V3"))
    (pad "2" smd rect (at 0.5 0) (size 0.6 0.5) (layers "F.Cu") (net 1 "GND"))
  ))`;

describe('网络高亮联动', () => {
  beforeEach(() => {
    const r = parseKicadPcb(PCB);
    useDesignStore.getState().importKicad(r);
    useDesignStore.getState().selectNet(null);
  });

  it('导入后 track / via / pad 都带真实网络号', () => {
    const doc = useDesignStore.getState().doc;
    expect(doc.tracks?.find((t) => t.net === 2)).toBeDefined();
    expect(doc.vias?.find((v) => v.net === 2)).toBeDefined();
    const u1 = doc.components.find((c) => c.reference === 'U1');
    expect(u1?.display?.padNets?.['1']).toBe(2);
    expect(u1?.display?.padNets?.['4']).toBe(1);
  });

  it('选中网络后可反查该网络的全部引脚（侧栏数据源）', () => {
    useDesignStore.getState().selectNet(2);
    const { doc, selectedNet } = useDesignStore.getState();
    expect(selectedNet).toBe(2);
    const nodes = doc.components.flatMap((c) =>
      Object.entries(c.display?.padNets ?? {})
        .filter(([, n]) => n === selectedNet)
        .map(([pad]) => `${c.reference}.${pad}`));
    expect(nodes.sort()).toEqual(['R1.1', 'U1.1']);
    expect(doc.nets?.['2']).toBe('+3V3');
  });

  it('GND 网络同样可反查，且与 +3V3 不混淆', () => {
    useDesignStore.getState().selectNet(1);
    const { doc } = useDesignStore.getState();
    const nodes = doc.components.flatMap((c) =>
      Object.entries(c.display?.padNets ?? {})
        .filter(([, n]) => n === 1)
        .map(([pad]) => `${c.reference}.${pad}`));
    expect(nodes.sort()).toEqual(['R1.2', 'U1.4']);
  });

  it('net 0（未连接）不产生高亮', () => {
    useDesignStore.getState().selectNet(0);
    expect(useDesignStore.getState().selectedNet).toBeNull();
  });

  it('取消高亮回到 null', () => {
    useDesignStore.getState().selectNet(2);
    useDesignStore.getState().selectNet(null);
    expect(useDesignStore.getState().selectedNet).toBeNull();
  });
});

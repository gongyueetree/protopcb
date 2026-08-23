import { describe, it, expect } from 'vitest';
import { parseKicadPcb } from '../../design-core/geometry/kicad-pcb-import';
import { buildKicadPcb } from './pcbExport';
import { createDocument } from '../../design-core/document/factory';
import { searchResultToPlaced } from '../../design-core/document/services';
import type { ComponentSearchResult } from '../../providers/types';

const PCB = `(kicad_pcb (version 20221018)
  (net 0 "")
  (net 1 "GND")
  (net 2 "+3V3")
  (gr_line (start 0 0) (end 30 0) (layer "Edge.Cuts") (width 0.05))
  (gr_line (start 30 0) (end 30 20) (layer "Edge.Cuts") (width 0.05))
  (gr_line (start 30 20) (end 0 20) (layer "Edge.Cuts") (width 0.05))
  (gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts") (width 0.05))
  (segment (start 5 5) (end 15 5) (width 0.25) (layer "F.Cu") (net 1))
  (segment (start 15 5) (end 15 12) (width 0.4) (layer "B.Cu") (net 2))
  (via (at 15 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))
  (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 10 10 90)
    (property "Reference" "R1")
    (pad "1" smd rect (at -0.8 0 90) (size 0.9 0.95) (layers "F.Cu") (net 1 "GND"))
    (pad "2" smd rect (at 0.8 0 90) (size 0.9 0.95) (layers "F.Cu") (net 2 "+3V3"))
  )
  (footprint "Capacitor_SMD:C_0603_1608Metric" (layer "B.Cu") (at 20 15)
    (property "Reference" "C1")
    (pad "1" smd rect (at -0.8 0) (size 0.9 0.95) (layers "B.Cu"))
  )
)`;

describe('KiCad 往返：导入 → 导出 → 再导入', () => {
  it('导入解析出走线/过孔/网络/层', () => {
    const r = parseKicadPcb(PCB);
    expect(r.widthMm).toBe(30);
    expect(r.heightMm).toBe(20);
    expect(r.tracks).toHaveLength(2);
    expect(r.tracks.find((t) => t.layer === 'bottom')?.w).toBe(0.4);   // 线宽保真
    expect(r.vias).toHaveLength(1);
    expect(Object.keys(r.nets).length).toBeGreaterThanOrEqual(3);
    expect(r.comps.find((c) => c.reference === 'C1')?.layer).toBe('bottom');
  });

  it('导出把走线/过孔/网络写回（此前完全丢失）', () => {
    const r = parseKicadPcb(PCB);
    const doc = createDocument({ name: 'rt' });
    doc.board.widthMm = r.widthMm; doc.board.heightMm = r.heightMm;
    doc.tracks = r.tracks; doc.vias = r.vias;
    doc.nets = Object.fromEntries(Object.entries(r.nets).map(([k, v]) => [k, String(v)]));
    doc.components = [searchResultToPlaced({
      componentId: 'ez_x', mpn: 'RC0603', manufacturer: 'Y', category: 'passive',
      defaultFootprintName: 'R_0603_1608Metric', family: 'Resistor', pins: 2,
    } as ComponentSearchResult, 'R1')];

    const out = buildKicadPcb(doc);
    expect((out.match(/\(segment /g) ?? [])).toHaveLength(2);
    expect((out.match(/\(via /g) ?? [])).toHaveLength(1);
    expect(out).toMatch(/\(net 1 "?GND"?\)/);   // KiCad 允许裸标识符，不强制引号
    expect(out).toContain('B.Cu');            // 底层未被简化掉
    expect(out).toContain('(width 0.4)');     // 原始线宽保留
  });

  it('导出结果能被自己的解析器读回，数量一致', () => {
    const r = parseKicadPcb(PCB);
    const doc = createDocument({ name: 'rt' });
    doc.board.widthMm = r.widthMm; doc.board.heightMm = r.heightMm;
    doc.tracks = r.tracks; doc.vias = r.vias;
    doc.nets = Object.fromEntries(Object.entries(r.nets).map(([k, v]) => [k, String(v)]));
    doc.components = [searchResultToPlaced({
      componentId: 'ez_x', mpn: 'RC0603', manufacturer: 'Y', category: 'passive',
      defaultFootprintName: 'R_0603_1608Metric', family: 'Resistor', pins: 2,
    } as ComponentSearchResult, 'R1')];

    const back = parseKicadPcb(buildKicadPcb(doc));
    expect(back.tracks).toHaveLength(2);
    expect(back.vias).toHaveLength(1);
    expect(back.widthMm).toBe(30);
    expect(back.heightMm).toBe(20);
  });
});

describe('器件可信等级', () => {
  it('ezPLM 器件标 VERIFIED，AI 子电路件标 PLACEHOLDER', () => {
    const ez = searchResultToPlaced({
      componentId: 'ez_1', mpn: 'STM32F103', manufacturer: 'ST', category: 'mcu',
      defaultFootprintName: 'LQFP-48', family: 'MCU', pins: 48,
    } as ComponentSearchResult, 'U1');
    expect(ez.trust?.level).toBe('VERIFIED');

    const ai = searchResultToPlaced({
      componentId: 'sub_U1_decap_0', mpn: '100nF', manufacturer: '—', category: 'passive',
      defaultFootprintName: 'C_0603_1608Metric', family: 'MLCC', pins: 2,
    } as ComponentSearchResult, 'C9');
    expect(ai.trust?.level).toBe('PLACEHOLDER');
    expect(ai.trust?.evidence).toContain('未经数据库验证');
  });
});

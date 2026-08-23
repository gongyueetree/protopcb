import { describe, it, expect } from 'vitest';
import { parseKicadPcb } from './kicad-pcb-import';

/** 20×10mm 板框，USB-C 故意放在板外 5mm 处（真实设计里连接器常外伸） */
const PCB_WITH_OUTSIDE_CONNECTOR = `(kicad_pcb (version 20221018)
  (gr_line (start 100 100) (end 120 100) (layer "Edge.Cuts") (width 0.05))
  (gr_line (start 120 100) (end 120 110) (layer "Edge.Cuts") (width 0.05))
  (gr_line (start 120 110) (end 100 110) (layer "Edge.Cuts") (width 0.05))
  (gr_line (start 100 110) (end 100 100) (layer "Edge.Cuts") (width 0.05))
  (footprint "Connector:USB_C" (layer "F.Cu")
    (at 125 105)
    (property "Reference" "J1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
  )
  (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu")
    (at 110 105)
    (property "Reference" "R1")
    (pad "1" smd rect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu"))
    (pad "2" smd rect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu"))
  )
)`;

/** 无 Edge.Cuts：此时才允许用器件位置兜底推断板框 */
const PCB_NO_OUTLINE = `(kicad_pcb (version 20221018)
  (footprint "R" (layer "F.Cu") (at 50 50) (property "Reference" "R1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))
  (footprint "R" (layer "F.Cu") (at 80 70) (property "Reference" "R2")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))
)`;

describe('KiCad 板框推断', () => {
  it('有 Edge.Cuts 时，外伸连接器不得撑大板框', () => {
    const r = parseKicadPcb(PCB_WITH_OUTSIDE_CONNECTOR);
    expect(r.widthMm).toBe(20);      // 严格按 Edge.Cuts，而非 125-100=25
    expect(r.heightMm).toBe(10);
    expect(r.originXMm).toBe(100);
    expect(r.originYMm).toBe(100);
  });

  it('外伸器件仍被导入，坐标可以是负数或超出板宽', () => {
    const r = parseKicadPcb(PCB_WITH_OUTSIDE_CONNECTOR);
    const j1 = r.comps.find((c) => c.reference === 'J1')!;
    expect(j1).toBeTruthy();
    expect(j1.xMm).toBe(25);          // 相对板左上角，超出板宽 20 —— 真实反映原设计
    const r1 = r.comps.find((c) => c.reference === 'R1')!;
    expect(r1.xMm).toBe(10);
    expect(r1.yMm).toBe(5);
  });

  it('无 Edge.Cuts 时才用器件位置兜底（含 10mm 边距）', () => {
    const r = parseKicadPcb(PCB_NO_OUTLINE);
    expect(r.widthMm).toBeGreaterThanOrEqual(30);   // 器件跨度 30mm + 边距
    expect(r.originXMm).toBe(0);                    // 兜底模式不报告 Edge.Cuts 原点
    expect(r.comps).toHaveLength(2);
  });
});

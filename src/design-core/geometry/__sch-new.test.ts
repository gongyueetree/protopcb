import { describe, it, expect } from 'vitest';
import { parseKicadSch } from './kicad-sch-import';

// KiCad 6/7 (.kicad_sch) 片段
const SCH = `(kicad_sch (version 20230121) (generator eeschema)
  (paper "A3")
  (title_block
    (title "Motor Driver Board")
    (date "2024-03-11")
    (rev "B")
    (company "EELIB")
    (comment 1 "内部评审版")
  )
  (lib_symbols
    (symbol "Device:R" (pin_numbers hide) (pin_names (offset 0))
      (symbol "R_0_1" (rectangle (start -1.016 2.54) (end 1.016 -2.54) (stroke (width 0.254)) (fill (type none))))
    )
  )
  (wire (pts (xy 100 50) (xy 120 50)))
  (bus (pts (xy 60 30) (xy 60 90)))
  (bus_entry (at 60 40) (size 2.54 2.54))
  (junction (at 120 50) (diameter 0) (color 0 0 0 0))
  (symbol (lib_id "Device:R") (at 120 60 90) (unit 1)
    (property "Reference" "R7" (at 122 58 0))
    (property "Value" "4.7k" (at 122 62 0))
  )
)`;

describe('KiCad 6+ 原理图：总线/图框/器件值', () => {
  it('总线与总线入口', () => {
    const r = parseKicadSch(SCH);
    expect(r.buses.length).toBe(1);
    expect(r.buses[0]).toEqual([[60, 30], [60, 90]]);
    expect(r.busEntries.length).toBe(1);
  });
  it('图纸尺寸与标题栏', () => {
    const r = parseKicadSch(SCH);
    expect(r.frame?.wMm).toBe(420);      // A3
    expect(r.frame?.hMm).toBe(297);
    expect(r.frame?.title).toBe('Motor Driver Board');
    expect(r.frame?.rev).toBe('B');
    expect(r.frame?.company).toBe('EELIB');
    expect(r.frame?.comments).toContain('内部评审版');
  });
  it('器件值（曾完全未解析）', () => {
    const r = parseKicadSch(SCH);
    expect(r.instances[0].ref).toBe('R7');
    expect(r.instances[0].value).toBe('4.7k');
  });
});

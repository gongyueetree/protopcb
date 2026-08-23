import { describe, it, expect } from 'vitest';
import { parseKicadSch, rawSymbolGeom } from './kicad-sch-import';

/** 与 ImportedSchematicView.makeXform 的 rot+mirror 分支保持一致 */
function xform(inst: { rot: number; mirror?: string }, px: number, py: number) {
  let sx = px, sy = -py;                    // 符号库 Y-up → 图纸 Y-down
  if (inst.mirror === 'x') sy = -sy;
  if (inst.mirror === 'y') sx = -sx;
  const a = (inst.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: sx * c - sy * s, y: sx * s + sy * c };   // 实测判定：取正
}

/** 取自真实工程 Openscope_RP2040.kicad_sch（KiCad 6+）的最小片段 */
const SCH = `(kicad_sch (version 20260306) (generator "eeschema") (paper "A3")
  (lib_symbols
    (symbol "power:GND" (power) (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes))
      (symbol "GND_0_1"
        (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)))
      )
      (symbol "GND_1_1"
        (pin power_in line (at 0 0 90) (length 0)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
      )
    )
    (symbol "power:+3V3" (power) (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes))
      (symbol "+3V3_0_1"
        (polyline (pts (xy -0.762 1.27) (xy 0 2.54)))
        (polyline (pts (xy 0 0) (xy 0 2.54)))
        (polyline (pts (xy 0 2.54) (xy 0.762 1.27)))
      )
      (symbol "+3V3_1_1"
        (pin power_in line (at 0 0 90) (length 0)
          (name "+3V3" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )
  (wire (pts (xy 100 50) (xy 100 45)))
  (wire (pts (xy 120 60) (xy 125 60)))
  (wire (pts (xy 140 70) (xy 135 70)))
  (symbol (lib_id "power:GND") (at 100 50 0) (unit 1)
    (property "Reference" "#PWR001" (at 100 56 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "GND" (at 100 55 0) (effects (font (size 1.27 1.27))))
  )
  (symbol (lib_id "power:GND") (at 120 60 270) (unit 1)
    (property "Reference" "#PWR002" (at 120 66 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "GND" (at 120 65 0) (effects (font (size 1.27 1.27))))
  )
  (symbol (lib_id "power:+3V3") (at 140 70 270) (unit 1)
    (property "Reference" "#PWR003" (at 140 64 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "+3V3" (at 140 65 0) (effects (font (size 1.27 1.27))))
  )
)`;

/** 图形质心相对管脚的方位 */
function graphicDir(r: ReturnType<typeof parseKicadSch>, ref: string) {
  const inst = r.instances.find((i) => i.ref === ref)!;
  const g = rawSymbolGeom(r.libSymbols[inst.libId]);
  const pts = g.polys.flat();
  const cs = pts.map((p) => xform(inst, p.x, p.y));
  const gx = cs.reduce((s, p) => s + p.x, 0) / cs.length;
  const gy = cs.reduce((s, p) => s + p.y, 0) / cs.length;
  return Math.abs(gy) > Math.abs(gx) ? (gy > 0 ? 'down' : 'up') : (gx > 0 ? 'right' : 'left');
}

describe('电源/GND 符号朝向（真实 KiCad 6 片段）', () => {
  const r = parseKicadSch(SCH);

  it('片段解析出 3 个电源符号与符号定义', () => {
    expect(r.instances.filter((i) => /^power:/.test(i.libId))).toHaveLength(3);
    expect(Object.keys(r.libSymbols)).toContain('power:GND');
  });

  it('库中 GND 图形在原点下方、+3V3 在上方', () => {
    const gy = rawSymbolGeom(r.libSymbols['power:GND']).polys.flat().map((p) => p.y);
    const vy = rawSymbolGeom(r.libSymbols['power:+3V3']).polys.flat().map((p) => p.y);
    expect(Math.min(...gy)).toBeLessThan(0);
    expect(Math.max(...vy)).toBeGreaterThan(0);
  });

  it('rot 0 的 GND 图形朝下（导线向上走）', () => {
    expect(graphicDir(r, '#PWR001')).toBe('down');
  });

  it('rot 270 的符号朝向水平，且与导线方向相反（此前反 180°）', () => {
    // rot270 把「朝下的 GND」转到水平方向；关键是两种符号朝向相反，
    // 且都不再是竖直（此前 90/270 会因旋转符号取反而反 180°）。
    const gnd270 = graphicDir(r, '#PWR002');
    const v3270 = graphicDir(r, '#PWR003');
    expect(['left', 'right']).toContain(gnd270);
    expect(['left', 'right']).toContain(v3270);
    expect(gnd270).not.toBe(v3270);   // GND 与电源符号朝向必然相反
  });
});

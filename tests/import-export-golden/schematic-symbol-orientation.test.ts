/**
 * 原理图符号朝向：KiCad 的 mirror 改变手性，旋转方向随之反向。
 * 判据用 KiCad 自己放置的 value 标签方向（标签总在图形那一侧），不靠肉眼。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseKicadSch } from '../../src/design-core/geometry/kicad-sch-import';

/** 与 ImportedSchematicView.makeXform 同一套规则（无 mat 的现代格式分支） */
function xform(px: number, py: number, rot: number, mirror?: string): [number, number] {
  let sx = px, sy = -py;
  if (mirror === 'x') sy = -sy;
  if (mirror === 'y') sx = -sx;
  const eff = mirror ? rot : -rot;
  const r = (eff * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [sx * c - sy * s, sx * s + sy * c];
}
const polyPts = (raw: string): [number, number][] =>
  [...raw.matchAll(/\(xy ([-\d.]+) ([-\d.]+)\)/g)].map((m) => [parseFloat(m[1]), parseFloat(m[2])]);

const PROJECT = '/home/claude/oi/OpenInstru2350B/OpenScope_RP2350B.kicad_sch';

describe('电源符号朝向（真实工程）', () => {
  const available = existsSync(PROJECT);
  it.runIf(available)('97 个电源符号的图形方向全部与 KiCad 的标签方向一致', () => {
    const sch = parseKicadSch(readFileSync(PROJECT, 'utf8'));
    let total = 0, ok = 0;
    for (const inst of sch.instances) {
      const raw = sch.libSymbols[inst.libId ?? ''];
      if (!/power:/.test(inst.libId ?? '') || !raw || !inst.valPos) continue;
      const pts = polyPts(raw);
      if (!pts.length) continue;
      total++;
      let cx = 0, cy = 0;
      for (const [x, y] of pts) { const [tx, ty] = xform(x, y, inst.rot, inst.mirror); cx += tx; cy += ty; }
      cx /= pts.length; cy /= pts.length;
      const wx = inst.valPos.x - inst.x, wy = inst.valPos.y - inst.y;
      if (cx * wx + cy * wy > 0) ok++;
    }
    expect(total).toBeGreaterThan(50);
    expect(ok).toBe(total);
  });

  it('规则本身：无镜像时旋转取负，有镜像时取正', () => {
    // 库坐标 (0,-2)（GND 三角在下）rot 0 → 屏幕下方
    expect(xform(0, -2, 0, undefined)[1]).toBeCloseTo(2, 6);
    // rot 90 无镜像：取 -90 → 图形转到 +x 一侧
    const [x90] = xform(0, -2, 90, undefined);
    expect(x90).toBeCloseTo(2, 6);
    // rot 90 带镜像 x：取 +90 → 同样落在 +x，但 y 分量符号相反
    const m90 = xform(0, -2, 90, 'x');
    expect(m90[0]).toBeCloseTo(2, 6);
  });
});

import { describe, it, expect } from 'vitest';
import { parseLegacyLib } from './kicad-lib-legacy';

/** 与 ImportedSchematicView.makeXform 的矩阵分支同款：先翻回库坐标再施加矩阵 */
const X = (mat: [number, number, number, number], px: number, py: number) => {
  const ly = -py;   // 旧库几何解析时已翻成 Y-down，这里翻回库坐标（Y-up）
  return { x: mat[0] * px + mat[1] * ly, y: mat[2] * px + mat[3] * ly };
};

const GND_LIB = `EESchema-LIBRARY Version 2.4
DEF power_GND #PWR 0 0 Y Y 1 F P
F0 "#PWR" 0 -250 50 H I C CNN
F1 "power_GND" 0 -150 50 H V C CNN
DRAW
P 6 0 1 0 0 0 0 -50 50 -50 0 -100 -50 -50 0 -50 N
X GND 1 0 0 0 D 50 50 1 1 W N
ENDDRAW
ENDDEF
#End Library`;

describe('电源/GND 符号朝向（曾因 Y 翻转两次反了 180°）', () => {
  const lib = parseLegacyLib(GND_LIB);
  const g = lib['power_GND'];
  const side = (mat: [number, number, number, number]) => {
    const pin = X(mat, g.pins[0].x, g.pins[0].y);
    const pts = g.polys.flat().map((p) => X(mat, p.x, p.y));
    const cx = pts.reduce((a, b) => a + b.x, 0) / pts.length;
    const cy = pts.reduce((a, b) => a + b.y, 0) / pts.length;
    return Math.abs(cy - pin.y) > Math.abs(cx - pin.x)
      ? (cy > pin.y ? 'down' : 'up')
      : (cx > pin.x ? 'right' : 'left');
  };

  it('符号库中 GND 图形位于管脚下方（默认朝向）', () => {
    expect(side([1, 0, 0, -1])).toBe('down');
  });

  it('翻转 180° 后图形在管脚上方', () => {
    expect(side([-1, 0, 0, 1])).toBe('up');
  });

  it('水平摆放时图形分居管脚左右两侧，而不是同一侧', () => {
    const a = side([0, 1, -1, 0]);
    const b = side([0, -1, 1, 0]);
    expect([a, b].sort()).toEqual(['left', 'right']);
  });

  it('管脚坐标是原点（连接点），图形不得与之重合', () => {
    const pin = X([1, 0, 0, -1], g.pins[0].x, g.pins[0].y);
    expect(pin.x).toBe(0);
    expect(Math.abs(pin.y)).toBe(0);   // ±0 都算原点
    expect(g.polys.flat().length).toBeGreaterThan(2);
  });
});

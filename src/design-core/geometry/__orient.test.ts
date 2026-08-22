import { describe, it, expect } from 'vitest';
import { parseLegacySch } from './kicad-sch-legacy';

// 同一符号的四个朝向 + 一个镜像（KiCad5 用 2x2 矩阵表达）
const SCH = `EESchema Schematic File Version 4
$Comp
L power:GND #PWR01
U 1 1 5F000001
P 1000 1000
F 0 "#PWR01" H 1000 750 50  0001 C CNN
F 1 "GND" H 1005 827 50  0000 C CNN
	1    1000 1000
	1    0    0    -1
$EndComp
$Comp
L power:GND #PWR02
U 1 1 5F000002
P 2000 1000
F 0 "#PWR02" H 2000 750 50  0001 C CNN
F 1 "GND" H 2005 827 50  0000 C CNN
	1    2000 1000
	0    1    -1   0
$EndComp
$Comp
L power:GND #PWR03
U 1 1 5F000003
P 3000 1000
F 0 "#PWR03" H 3000 750 50  0001 C CNN
F 1 "GND" H 3005 827 50  0000 C CNN
	1    3000 1000
	0    -1   1    0
$EndComp
$EndSCHEMATC`;

/** 与渲染同款：矩阵直接变换（x' = a·x + b·y, y' = c·x + d·y） */
function applyMat(mat: [number, number, number, number], px: number, py: number) {
  const [a, b, c, d] = mat;
  return { x: a * px + b * py, y: c * px + d * py };
}

describe('KiCad5 方向矩阵直接用于渲染（拆成 rot+mirror 会 180° 出错）', () => {
  it('每个实例都保留原始矩阵', () => {
    const r = parseLegacySch(SCH);
    expect(r.comps.length).toBe(3);
    expect(r.comps.every((c) => c.mat)).toBe(true);
    expect(r.comps[0].mat).toEqual([1, 0, 0, -1]);   // 默认朝向
    expect(r.comps[1].mat).toEqual([0, 1, -1, 0]);
    expect(r.comps[2].mat).toEqual([0, -1, 1, 0]);
  });

  it('左右摆放的 GND 管脚指向相反（此前两者被渲染成同一朝向）', () => {
    const r = parseLegacySch(SCH);
    // GND 符号的管脚在本体上方（符号坐标 Y-up 的 +Y 方向）
    const pin = { x: 0, y: 1 };
    const a = applyMat(r.comps[1].mat!, pin.x, pin.y);
    const b = applyMat(r.comps[2].mat!, pin.x, pin.y);
    expect(a.x).toBeCloseTo(-b.x);   // 一个朝左、一个朝右
    expect(a.x).not.toBeCloseTo(0);
  });

  it('默认朝向把符号 Y-up 映射为屏幕 Y-down', () => {
    const r = parseLegacySch(SCH);
    expect(applyMat(r.comps[0].mat!, 0, 1)).toEqual({ x: 0, y: -1 });
  });
});

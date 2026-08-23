import { describe, it, expect } from 'vitest';
import { parseKicadSch, rawSymbolGeom } from './kicad-sch-import';

// 真实 KiCad 6 结构：电源符号 + 旋转270°/镜像的电阻 + 用户调过位置和方向的位号/值
const SCH = `(kicad_sch (version 20230121) (paper "A4")
	(lib_symbols
		(symbol "Device:R" (pin_numbers hide)
			(symbol "R_0_1" (rectangle (start -1.016 2.54) (end 1.016 -2.54)))
			(symbol "R_1_1"
				(pin passive line (at 0 3.81 270) (length 1.27)
					(name "~" (effects (font (size 1.27 1.27))))
					(number "1" (effects (font (size 1.27 1.27))))
				)
			)
		)
		(symbol "MCU:U1" (pin_names (offset 1.016))
			(symbol "U1_1_1"
				(pin power_in line (at -12.7 5.08 0) (length 2.54)
					(name "VDD" (effects (font (size 1.27 1.27))))
					(number "1" (effects (font (size 1.27 1.27))))
				)
				(pin bidirectional line (at 12.7 0 180) (length 2.54)
					(name "PA9/TX" (effects (font (size 1.27 1.27))))
					(number "22" (effects (font (size 1.27 1.27))))
				)
			)
		)
	)
	(symbol (lib_id "power:GND") (at 133.35 92.71 0) (unit 1)
		(property "Reference" "#PWR03" (at 133.35 99.06 0) (effects (font (size 1.27 1.27)) hide))
		(property "Value" "GND" (at 133.35 97.79 0) (effects (font (size 1.27 1.27))))
	)
	(symbol (lib_id "Device:R") (at 96.52 74.93 270) (mirror y) (unit 1)
		(property "Reference" "R12" (at 96.52 71.12 90) (effects (font (size 1.27 1.27))))
		(property "Value" "4.7k" (at 96.52 78.74 90) (effects (font (size 1.27 1.27))))
	)
)`;

describe('KiCad 6 原理图渲染所需数据', () => {
  it('管脚名被解析（此前 RawSymGeom 根本没有 name 字段）', () => {
    const r = parseKicadSch(SCH);
    const g = rawSymbolGeom(r.libSymbols['MCU:U1']);
    expect(g.pins.length).toBe(2);
    expect(g.pins.find((p) => p.number === '1')?.name).toBe('VDD');
    expect(g.pins.find((p) => p.number === '22')?.name).toBe('PA9/TX');
  });

  it('name 为 ~ 表示无名，不显示', () => {
    const r = parseKicadSch(SCH);
    const g = rawSymbolGeom(r.libSymbols['Device:R']);
    expect(g.pins[0].name).toBeUndefined();
  });

  it('电源符号的网络名来自 Value（位号 #PWR 在 KiCad 中隐藏）', () => {
    const r = parseKicadSch(SCH);
    const gnd = r.instances.find((i) => i.libId === 'power:GND')!;
    expect(gnd.value).toBe('GND');
    expect(gnd.refPos?.hidden).toBe(true);    // 位号隐藏
    expect(gnd.valPos?.hidden).toBe(false);   // 值显示
  });

  it('用户调整过的位号/值方向与位置被保留（不用库里的固定位置）', () => {
    const r = parseKicadSch(SCH);
    const res = r.instances.find((i) => i.ref === 'R12')!;
    expect(res.rot).toBe(270);
    expect(res.mirror).toBe('y');
    expect(res.refPos).toEqual({ x: 96.52, y: 71.12, rot: 90, hidden: false });
    expect(res.valPos).toEqual({ x: 96.52, y: 78.74, rot: 90, hidden: false });
  });
});

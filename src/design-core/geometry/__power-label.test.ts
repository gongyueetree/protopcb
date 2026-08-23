import { describe, it, expect } from 'vitest';
import { parseKicadSch } from './kicad-sch-import';

/** 与渲染同款判定：是否按电源符号处理、显示什么文字 */
const isPower = (ref: string, libId: string) => ref.startsWith('#') || /^power[:_]/i.test(libId);
const labelOf = (inst: { ref: string; libId: string; value?: string }) =>
  inst.value || inst.libId.split(':').pop() || '';

const SCH = `(kicad_sch (version 20230121) (paper "A4")
	(symbol (lib_id "power:GND") (at 133.35 92.71 0) (unit 1)
		(property "Reference" "#PWR03" (at 133.35 99.06 0) (effects (font (size 1.27 1.27)) hide))
		(property "Value" "GND" (at 133.35 97.79 0) (effects (font (size 1.27 1.27))))
	)
	(symbol (lib_id "power:+3V3") (at 100 50 0) (unit 1)
		(property "Reference" "#PWR07" (at 100 55 0) (effects (font (size 1.27 1.27)) hide))
		(property "Value" "+3V3" (at 100 46 0) (effects (font (size 1.27 1.27))))
	)
	(symbol (lib_id "Device:R") (at 96.52 74.93 270) (unit 1)
		(property "Reference" "R12" (at 96.52 71.12 90) (effects (font (size 1.27 1.27))))
		(property "Value" "4.7k" (at 96.52 78.74 90) (effects (font (size 1.27 1.27))))
	)
)`;

describe('电源/GND 符号文字', () => {
  it('电源符号被识别，普通器件不被误判', () => {
    const r = parseKicadSch(SCH);
    const gnd = r.instances.find((i) => i.ref === '#PWR03')!;
    const v33 = r.instances.find((i) => i.ref === '#PWR07')!;
    const res = r.instances.find((i) => i.ref === 'R12')!;
    expect(isPower(gnd.ref, gnd.libId)).toBe(true);
    expect(isPower(v33.ref, v33.libId)).toBe(true);
    expect(isPower(res.ref, res.libId)).toBe(false);
  });

  it('显示的是网络名而非 #PWR 位号', () => {
    const r = parseKicadSch(SCH);
    expect(labelOf(r.instances.find((i) => i.ref === '#PWR03')!)).toBe('GND');
    expect(labelOf(r.instances.find((i) => i.ref === '#PWR07')!)).toBe('+3V3');
  });

  it('位号隐藏但值可见（渲染必须用值）', () => {
    const r = parseKicadSch(SCH);
    const gnd = r.instances.find((i) => i.ref === '#PWR03')!;
    expect(gnd.refPos?.hidden).toBe(true);
    expect(gnd.valPos?.hidden).toBe(false);
  });

  it('外层条件不得把 # 开头的位号排除在文字渲染之外', () => {
    // 回归：曾用 !ref.startsWith('#') 包裹 isPower 分支，两者互斥 → 电源文字永不渲染
    const r = parseKicadSch(SCH);
    const powered = r.instances.filter((i) => isPower(i.ref, i.libId));
    expect(powered.length).toBe(2);
    expect(powered.every((i) => labelOf(i).length > 0)).toBe(true);
  });
});

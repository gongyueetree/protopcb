import { describe, it, expect } from 'vitest';
import { padFootprintFor } from './footprint-pads';
import { synthFootprintName, buildCustomFootprint } from '../custom-lib';
import type { CustomPkg } from '../custom-lib';

const pkg = (o: Partial<CustomPkg>): CustomPkg => ({ family: 'dual', bodyW: 3, bodyH: 3, pitch: 0.65, ...o } as CustomPkg);

describe('封装解析：奇数管脚与常用族', () => {
  it('SOT-23-5（奇数脚）可解析 —— 用户实际卡住的场景', () => {
    const fp = padFootprintFor('SOT-23-5')!;
    expect(fp).toBeTruthy();
    expect(fp.pads).toHaveLength(5);
    // 左 3 右 2，且右侧两脚在外侧（中间空）
    const left = fp.pads.filter((p) => p.x < 0), right = fp.pads.filter((p) => p.x > 0);
    expect(left).toHaveLength(3);
    expect(right).toHaveLength(2);
  });

  it('双列封装支持奇数脚，不再凑成偶数补出不存在的焊盘', () => {
    const fp = padFootprintFor('SOP-5_2.9x1.6mm_P0.95mm')!;
    expect(fp.pads).toHaveLength(5);           // 修复前为 6
    expect(fp.pads.filter((p) => p.x < 0)).toHaveLength(3);   // 左列多一个
    expect(fp.pads.filter((p) => p.x > 0)).toHaveLength(2);
    // 编号连续且唯一
    expect([...new Set(fp.pads.map((p) => Number(p.num)))].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('新增常用族均可解析', () => {
    for (const [name, pads] of [['SOT-89-3', 4], ['SC-70-5', 5], ['SOT-353', 5], ['SOT-363', 6],
      ['TO-252-3', 4], ['TO-220-3', 3], ['TO-247-3', 3]] as [string, number][]) {
      const fp = padFootprintFor(name);
      expect(fp, name).toBeTruthy();
      expect(fp!.pads.length, name).toBe(pads);
    }
  });

  it('TO-252/SOT-89 含散热焊盘（比引脚数多一个）', () => {
    const dpak = padFootprintFor('TO-252-3')!;
    const big = dpak.pads.reduce((a, b) => (a.w * a.h > b.w * b.h ? a : b));
    expect(big.w * big.h).toBeGreaterThan(20);   // 散热焊盘显著大于引脚
  });

  it('TO-220 是直插（圆焊盘）', () => {
    const fp = padFootprintFor('TO-220-3')!;
    expect(fp.pads.every((p) => p.round)).toBe(true);
  });
});

describe('定制向导：各族端到端生成', () => {
  const cases: [string, CustomPkg, number, number][] = [
    ['SOT-23-5', pkg({ family: 'sot', bodyW: 1.6, bodyH: 2.9, pitch: 0.95 }), 5, 5],
    ['SOT-23-6', pkg({ family: 'sot', bodyW: 1.6, bodyH: 2.9, pitch: 0.95 }), 6, 6],
    ['SOT-23-3', pkg({ family: 'sot', bodyW: 1.6, bodyH: 2.9, pitch: 0.95 }), 3, 3],
    ['SC-70-5', pkg({ family: 'sot', bodyW: 1.2, bodyH: 2.0, pitch: 0.65 }), 5, 5],
    ['SOD-123', pkg({ family: 'sod', bodyW: 2.7, bodyH: 1.6 }), 2, 2],
    ['TO-220-3', pkg({ family: 'to220', bodyW: 10.2, bodyH: 15, pitch: 2.54 }), 3, 3],
    ['SOP-8', pkg({ family: 'dual', bodyW: 3.9, bodyH: 4.9, pitch: 1.27 }), 8, 8],
    ['SOP-5(奇数)', pkg({ family: 'dual', bodyW: 2.9, bodyH: 1.6, pitch: 0.95 }), 5, 5],
    ['QFN-16', pkg({ family: 'qfn', bodyW: 3, bodyH: 3, pitch: 0.5 }), 16, 16],
    ['BGA-64', pkg({ family: 'bga', bodyW: 8, bodyH: 8, pitch: 0.8 }), 64, 64],
  ];

  it.each(cases)('%s 能生成且焊盘数正确', (_label, p, pins, expected) => {
    const fp = buildCustomFootprint(p, pins);
    expect(fp).toBeTruthy();
    expect(fp!.pads).toHaveLength(expected);
    expect(fp!.bodyW).toBeGreaterThan(0);
  });

  it('DPAK 生成 3 引脚 + 1 散热焊盘', () => {
    const fp = buildCustomFootprint(pkg({ family: 'dpak', bodyW: 6.5, bodyH: 6.1, pitch: 2.28 }), 3)!;
    expect(fp.pads).toHaveLength(4);
  });

  it('SOT 族按脚数选对变体名', () => {
    const p = pkg({ family: 'sot', bodyW: 1.6, bodyH: 2.9, pitch: 0.95 });
    expect(synthFootprintName(p, 5)).toBe('SOT-23-5');
    expect(synthFootprintName(p, 3)).toBe('SOT-23-3');
    expect(synthFootprintName(p, 4)).toBe('SOT-223');
    expect(synthFootprintName(pkg({ family: 'sot', bodyW: 1.2, bodyH: 2, pitch: 0.65 }), 5)).toBe('SC-70-5');
  });
});

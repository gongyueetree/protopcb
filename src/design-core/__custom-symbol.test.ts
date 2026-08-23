import { describe, it, expect } from 'vitest';
import { buildCustomSymbol, symbolSideSummary } from './custom-symbol';
import { buildCustomFootprint } from './custom-lib';
import type { CustomPin, CustomPkg } from './custom-lib';

const P = (num: string, name: string, type: CustomPin['type'], side?: CustomPin['side']): CustomPin =>
  ({ num, name, type, side });

describe('定制器件原理图符号生成', () => {
  it('LDO（SOT-23-5 常见）：电源在上、地在下、输入左、输出右', () => {
    const s = buildCustomSymbol([
      P('1', 'VIN', 'power_in'), P('2', 'GND', 'power_in'), P('3', 'EN', 'input'),
      P('4', 'NC', 'no_connect'), P('5', 'VOUT', 'power_out'),
    ])!;
    expect(s).toBeTruthy();
    expect(s.pins).toHaveLength(5);
    const at = (n: string) => s.pins.find((p) => p.number === n)!;
    const cx = s.w / 2, cy = s.h / 2;
    expect(at('1').tipY).toBeLessThan(cy);      // VIN 在上
    expect(at('2').tipY).toBeGreaterThan(cy);   // GND 在下
    expect(at('3').tipX).toBeLessThan(cx);      // EN 输入在左
    expect(at('5').tipX).toBeGreaterThan(cx);   // VOUT 输出在右
  });

  it('坐标全为正且在画布内（旧实现有负坐标，符号跑出画框）', () => {
    const s = buildCustomSymbol([
      P('1', 'VDD', 'power_in'), P('2', 'GND', 'power_in'),
      P('3', 'SCL', 'input'), P('4', 'SDA', 'bidirectional'),
    ])!;
    for (const p of s.pins) {
      expect(p.tipX).toBeGreaterThanOrEqual(0);
      expect(p.tipY).toBeGreaterThanOrEqual(0);
      expect(p.tipX).toBeLessThanOrEqual(s.w);
      expect(p.tipY).toBeLessThanOrEqual(s.h);
    }
    expect(s.rects).toHaveLength(1);
  });

  it('管脚名与编号完整保留（这是从数据手册提取的核心价值）', () => {
    const s = buildCustomSymbol([P('1', 'PA9/TX', 'output'), P('22', 'NRST', 'input')])!;
    expect(s.pins.find((p) => p.number === '1')!.name).toBe('PA9/TX');
    expect(s.pins.find((p) => p.number === '22')!.name).toBe('NRST');
  });

  it('电流路径类 power 脚不被顶到上边（ds2kicad 的实战教训）', () => {
    // 电流传感器：8 个 IP 脚是电流通路，不是供电
    const pins = [
      ...Array.from({ length: 4 }, (_, i) => P(String(i + 1), 'IP+', 'power_in')),
      ...Array.from({ length: 4 }, (_, i) => P(String(i + 5), 'IP-', 'power_out')),
      P('9', 'VCC', 'power_in'), P('10', 'GND', 'power_in'),
    ];
    const sum = symbolSideSummary(pins);
    expect(sum.top).toBe(1);          // 只有 VCC 在上
    expect(sum.bottom).toBe(1);       // 只有 GND 在下
    expect(sum.left).toBe(4);         // IP+ 入左
    expect(sum.right).toBe(4);        // IP- 出右
  });

  it('正电源超过 3 个时顶排自动扩展（不改变引脚功能布局语义）', () => {
    const pins = Array.from({ length: 6 }, (_, i) => P(String(i + 1), `VDD${i}`, 'power_in'));
    const sum = symbolSideSummary(pins);
    // 此前会把多出的电源脚硬塞到左列（改变语义）；现在全部保留在顶排，符号宽度随之扩展
    expect(sum.top).toBe(6);
    expect(sum.left).toBe(0);
  });

  it('散热焊盘 EP 归到底部', () => {
    expect(symbolSideSummary([P('33', 'EP', 'passive'), P('1', 'IN', 'input')]).bottom).toBe(1);
  });

  it('用户在向导里指定的边优先于自动分类', () => {
    const sum = symbolSideSummary([P('1', 'VCC', 'power_in', 'left'), P('2', 'GND', 'power_in', 'right')]);
    expect(sum.left).toBe(1);
    expect(sum.right).toBe(1);
    expect(sum.top).toBe(0);
  });

  it('无管脚时返回 null，不产出空符号', () => {
    expect(buildCustomSymbol([])).toBeNull();
  });
});

describe('定制器件 3D 本体尺寸', () => {
  it('手动焊盘模式采用向导填写的本体尺寸（此前被焊盘范围覆盖）', () => {
    const pkg: CustomPkg = {
      family: 'manual', bodyW: 10, bodyH: 8, pitch: 2.54,
      manualPads: [
        { num: '1', x: -3, y: 0, w: 1.5, h: 1.5, round: true },
        { num: '2', x: 3, y: 0, w: 1.5, h: 1.5, round: true },
      ],
    } as CustomPkg;
    const fp = buildCustomFootprint(pkg, 2)!;
    expect(fp.bodyW).toBe(10);      // 修复前按焊盘范围算成 8.5
    expect(fp.bodyH).toBe(8);       // 修复前 2.5
    expect(fp.pads).toHaveLength(2);
  });

  it('自定义轮廓优先级高于本体尺寸', () => {
    const pkg: CustomPkg = {
      family: 'manual', bodyW: 10, bodyH: 8, pitch: 2.54, outlineW: 20, outlineH: 15,
      manualPads: [{ num: '1', x: 0, y: 0, w: 1, h: 1, round: false }],
    } as CustomPkg;
    const fp = buildCustomFootprint(pkg, 1)!;
    expect(fp.bodyW).toBe(20);
    expect(fp.bodyH).toBe(15);
  });
});

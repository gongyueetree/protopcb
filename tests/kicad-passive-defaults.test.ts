/**
 * 无源器件默认符号/封装：统一到 KiCad 官方画法
 */
import { describe, it, expect } from 'vitest';
import { classifyPassive, kicadPassiveDefaults, sizeCodeOf } from '../src/design-core/geometry/kicad-passive-defaults';

describe('类别判定', () => {
  it('位号优先', () => {
    expect(classifyPassive('C12', '')).toBe('capacitor');
    expect(classifyPassive('R5', '')).toBe('resistor');
    expect(classifyPassive('L1', '')).toBe('inductor');
    expect(classifyPassive('Y1', '')).toBe('crystal');
  });
  it('无位号时靠值/描述', () => {
    expect(classifyPassive('', '100nF')).toBe('capacitor');
    expect(classifyPassive('', '10kΩ')).toBe('resistor');
    expect(classifyPassive('', '22uH')).toBe('inductor');
  });
  it('TVS/肖特基/稳压管不被普通二极管吞掉', () => {
    expect(classifyPassive('D2', 'TVS二极管阵列')).toBe('tvs');
    expect(classifyPassive('D3', 'Schottky 40V')).toBe('schottky');
    expect(classifyPassive('ZD1', 'Zener 3.3V')).toBe('zener');
    expect(classifyPassive('D4', '通用二极管')).toBe('diode');
  });
  it('判不出来返回 undefined（不硬猜）', () => {
    expect(classifyPassive('U7', 'SGM8301')).toBeUndefined();
    expect(classifyPassive('J1', 'USB-C')).toBeUndefined();
  });
});

describe('默认符号与封装', () => {
  it('电容 → C_Small + C_0402_1005Metric', () => {
    const d = kicadPassiveDefaults('C1', '100nF')!;
    expect(d.symbol).toBe('Device:C_Small');
    expect(d.footprint).toBe('C_0402_1005Metric');
  });
  it('电阻 → R_Small + R_0402_1005Metric', () => {
    const d = kicadPassiveDefaults('R1', '10k')!;
    expect(d.symbol).toBe('Device:R_Small');
    expect(d.footprint).toBe('R_0402_1005Metric');
  });
  it('电感/磁珠/LED 各自的官方符号', () => {
    expect(kicadPassiveDefaults('L1', '22uH')!.symbol).toBe('Device:L_Small');
    expect(kicadPassiveDefaults('FB1', '磁珠')!.symbol).toBe('Device:FerriteBead_Small');
    expect(kicadPassiveDefaults('D1', 'LED 绿')!.symbol).toBe('Device:LED_Small');
  });
  it('已指定尺寸时沿用，不强行改成 0402', () => {
    expect(kicadPassiveDefaults('C9', '10uF', '', 'C_0805_2012Metric')!.footprint).toBe('C_0805_2012Metric');
    expect(kicadPassiveDefaults('R3', '1k', '', 'R_0603_1608Metric')!.footprint).toBe('R_0603_1608Metric');
  });
  it('非片式器件用固定封装', () => {
    expect(kicadPassiveDefaults('D5', 'TVS')!.footprint).toBe('D_SOD-323');
    expect(kicadPassiveDefaults('Y1', '8MHz 晶振')!.footprint).toMatch(/Crystal_SMD/);
  });
  it('非无源件返回 undefined', () => {
    expect(kicadPassiveDefaults('U1', 'STM32F103C8T6')).toBeUndefined();
  });
  it('尺寸代号提取（下划线分隔也能识别）', () => {
    expect(sizeCodeOf('R_0603_1608Metric')).toBe('0603');
    expect(sizeCodeOf('SOT-23-5')).toBeUndefined();
  });
});

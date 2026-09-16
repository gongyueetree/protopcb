/**
 * Phase 11：网络语义唯一实现 —— 尤其修复 VIN/VOUT 在两处判定相反的矛盾
 */
import { describe, it, expect } from 'vitest';
import { classifyNet, classifyNetByName, toCoarseKind } from '../../src/design-core/semantics/net';
import { classifyNet as fragmentClassify } from '../../src/design-core/fragment/extract';

describe('无歧义名称', () => {
  it('地', () => { for (const n of ['GND', 'AGND', 'PGND', 'VSS', 'GND_A']) expect(classifyNetByName(n)).toBe('GROUND'); });
  it('电源', () => { for (const n of ['+3V3', '+5V', 'VCC', 'VDD', 'VBUS', '3V3', '12V', 'AVDD']) expect(classifyNetByName(n)).toBe('POWER'); });
  it('时钟', () => { for (const n of ['MCLK', 'XTAL_IN', 'SPI_SCLK', 'CLK_OUT']) expect(classifyNetByName(n)).toBe('CLOCK'); });
  it('差分', () => { for (const n of ['USB_DP', 'USB_DM', 'TX_P', 'LVDS_CLK_N']) expect(classifyNetByName(n)).toBe('DIFF_PAIR'); });
  it('SCL 不是时钟（I2C 总线）', () => { expect(classifyNetByName('I2C_SCL')).not.toBe('CLOCK'); });
});

describe('歧义名 VIN / VOUT：不只看名字', () => {
  it('纯名字 → UNKNOWN（禁止猜）', () => {
    expect(classifyNetByName('VIN')).toBe('UNKNOWN');
    expect(classifyNetByName('VOUT')).toBe('UNKNOWN');
  });
  it('LDO 的 VOUT（power_out 驱动、电源脚占多数）→ POWER', () => {
    expect(classifyNet({ name: 'VOUT', pins: [
      { pinType: 'power_out', componentCategory: 'power' }, { pinType: 'power_in', componentCategory: 'mcu' }, { pinType: 'passive' },
    ] })).toBe('POWER');
  });
  it('DAC 的 VOUT（全是无源/输出脚，没有电源脚）→ ANALOG', () => {
    expect(classifyNet({ name: 'VOUT', pins: [
      { pinType: 'output', componentCategory: 'ic' }, { pinType: 'passive', componentCategory: 'passive' },
    ] })).toBe('ANALOG');
  });
  it('挂在电源类器件上且有电源脚 → POWER', () => {
    expect(classifyNet({ name: 'VIN', pins: [{ pinType: 'power_in', componentCategory: 'power' }, { pinType: 'passive' }] })).toBe('POWER');
  });
});

describe('调用方一致', () => {
  it('fragment 的粗粒度分类与统一分类器同源', () => {
    expect(fragmentClassify('GND')).toBe('GROUND');
    expect(fragmentClassify('+3V3')).toBe('POWER');
    expect(fragmentClassify('MCLK')).toBe('CLOCK');
    expect(fragmentClassify('VOUT')).toBe('SIGNAL');   // 无证据不猜成电源
    expect(toCoarseKind('DIFF_PAIR')).toBe('SIGNAL');
  });
  it('from-netlist 不再有自己的 POWER_NAME 正则', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/design-core/block-diagram/from-netlist.ts', import.meta.url), 'utf8'));
    expect(src).not.toMatch(/const POWER_NAME/);
    expect(src).toMatch(/from '\.\.\/semantics\/net'/);
  });
});

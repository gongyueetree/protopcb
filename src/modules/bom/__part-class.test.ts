import { describe, it, expect } from 'vitest';
import { classifyByRefDes, isPriceable, whyNotPriceable, pricingPriority } from './part-class';

describe('BOM 位号分类与估价门槛', () => {
  it('用户实例：D1 / STA / LED_0603 不应被估价（曾查出 1800 美元）', () => {
    expect(classifyByRefDes('D1', 'LED_0603_1608Metric', 'STA')).toBe('led');
    expect(isPriceable('STA', 'D1', 'LED_0603_1608Metric')).toBe(false);
    expect(whyNotPriceable('STA', 'D1', 'LED_0603_1608Metric')).toBe('缺少明确型号');
  });

  it('位号前缀正确分类', () => {
    expect(classifyByRefDes('U3', 'QFN-32')).toBe('ic');
    expect(classifyByRefDes('Q2', 'SOT-23')).toBe('transistor');
    expect(classifyByRefDes('D5', 'D_SOD-123')).toBe('diode');
    expect(classifyByRefDes('R19', 'R_0603_1608Metric')).toBe('resistor');
    expect(classifyByRefDes('J1', 'USB_C_Receptacle')).toBe('connector');
    expect(classifyByRefDes('H2', 'Hole_3mm')).toBe('mechanical');
  });

  it('元件值不是型号，一律不查', () => {
    expect(isPriceable('10K', 'R1', 'R_0603_1608Metric')).toBe(false);
    expect(isPriceable('100nF', 'C1', 'C_0603_1608Metric')).toBe(false);
    expect(isPriceable('4K7', 'R2', '')).toBe(false);
    expect(isPriceable('8MHz', 'Y1', '')).toBe(false);
    expect(isPriceable('CUSTOM_X1', 'U9', '')).toBe(false);
    expect(whyNotPriceable('100nF', 'C1', '')).toBe('这是元件值不是型号');
  });

  it('真实料号才放行', () => {
    expect(isPriceable('STM32F103C8T6', 'U1', 'LQFP-48')).toBe(true);
    expect(isPriceable('LTST-C190KRKT', 'D1', 'LED_0603_1608Metric')).toBe(true);
    expect(isPriceable('RC0603FR-0710KL', 'R1', 'R_0603_1608Metric')).toBe(true);
  });

  it('结构件永不估价；IC 优先级高于无源件', () => {
    expect(isPriceable('Hole_3mm', 'H1', 'Hole_3mm')).toBe(false);
    expect(pricingPriority('ic')).toBeLessThan(pricingPriority('resistor'));
    expect(pricingPriority('transistor')).toBeLessThan(pricingPriority('capacitor'));
  });
});

import { describe, it, expect } from 'vitest';

/** 与渲染同款：有效文字角 = 字段角 − 器件角，归一到 0/90 */
const textAngle = (fieldRot: number, symRot: number) => {
  const eff = (((fieldRot - symRot) % 180) + 180) % 180;
  return eff === 90 ? 90 : 0;
};

describe('原理图标注方向（KiCad 字段角含器件旋转）', () => {
  it('水平电阻（符号270°/字段90°）的位号与值应水平', () => {
    expect(textAngle(90, 270)).toBe(0);
    expect(textAngle(90, 90)).toBe(0);
  });
  it('竖直电阻（符号0°/字段0°）保持水平文字', () => {
    expect(textAngle(0, 0)).toBe(0);
  });
  it('用户特意把标注转成竖排时保留竖排', () => {
    expect(textAngle(90, 0)).toBe(90);
    expect(textAngle(0, 90)).toBe(90);
  });
});

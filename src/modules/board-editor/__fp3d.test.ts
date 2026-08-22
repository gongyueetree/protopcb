import { describe, it, expect } from 'vitest';

// 只测纯函数式的分派规则（不引 three.js 场景）
function chipSize(K: string) {
  const m = K.match(/_(\d{4})_/);
  const map: Record<string, [number, number, number]> = {
    '0201': [0.6, 0.3, 0.3], '0402': [1.0, 0.5, 0.5], '0603': [1.6, 0.8, 0.8],
    '0805': [2.0, 1.25, 1.1], '1206': [3.2, 1.6, 1.1], '1210': [3.2, 2.5, 1.3],
  };
  return m && map[m[1]] ? map[m[1]] : null;
}
function headerDims(K: string) {
  const hdr = K.match(/PINHEADER_(\d)X(\d{1,2})|PINSOCKET_(\d)X(\d{1,2})/);
  if (!hdr) return null;
  return { rows: Number(hdr[1] ?? hdr[3] ?? 1), cols: Number(hdr[2] ?? hdr[4] ?? 2) };
}

describe('3D 参数化模型按封装名分派（曾全部落 default → 整板一个颜色）', () => {
  it('贴片尺寸从 KiCad 封装名解析', () => {
    expect(chipSize('R_0603_1608METRIC')).toEqual([1.6, 0.8, 0.8]);
    expect(chipSize('C_0402_1005METRIC')).toEqual([1.0, 0.5, 0.5]);
    expect(chipSize('LED_1206_3216METRIC')).toEqual([3.2, 1.6, 1.1]);
    expect(chipSize('QFN-32-1EP_5X5MM_P0.5MM')).toBeNull();
  });
  it('2.54 排针按名字取真实排列（原来固定 2x5）', () => {
    expect(headerDims('PINHEADER_1X02_P2.54MM_HORIZONTAL')).toEqual({ rows: 1, cols: 2 });
    expect(headerDims('PINHEADER_2X10_P2.54MM_VERTICAL')).toEqual({ rows: 2, cols: 10 });
    expect(headerDims('PINSOCKET_1X08_P2.54MM')).toEqual({ rows: 1, cols: 8 });
    expect(headerDims('USB_C_RECEPTACLE')).toBeNull();
  });
  it('器件族判定：电阻/电容/LED 应走不同材质分支', () => {
    const fam = (K: string) => /^R_/.test(K) ? 'R' : /^C_/.test(K) ? 'C' : /^LED_/.test(K) ? 'LED' : /^L_|^FB_/.test(K) ? 'L' : 'other';
    expect(fam('R_0603_1608METRIC')).toBe('R');
    expect(fam('C_0603_1608METRIC')).toBe('C');
    expect(fam('LED_0603_1608METRIC')).toBe('LED');
    expect(fam('L_0805_2012METRIC')).toBe('L');
  });
});

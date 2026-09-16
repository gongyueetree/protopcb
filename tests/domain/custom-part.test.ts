/**
 * Custom Part 校验与封装尺寸图驱动回归
 *  验收 9：重复 pin number 必须拒绝保存
 *  新需求：封装机械图参数（padLen/padWidth/leadSpan/heightMm）驱动封装与 3D
 */
import { describe, it, expect } from 'vitest';
import { validateCustomPartDraft } from '../../src/design-core/custom-part-schema';
import { buildCustomFootprint, CUSTOM_FAMILIES } from '../../src/design-core/custom-lib';
import { buildCustomSymbol } from '../../src/design-core/custom-symbol';
import type { CustomPin } from '../../src/design-core/custom-lib';

const basePkg = { family: 'dual' as const, bodyW: 4.9, bodyH: 3.9, pitch: 1.27 };
const pin = (num: string, name = 'P' + num, type: CustomPin['type'] = 'passive'): CustomPin => ({ num, name, type });

describe('CustomPartDraftSchema', () => {
  it('验收9：重复脚号拒绝保存', () => {
    const r = validateCustomPartDraft({
      mpn: 'X1', category: 'ic', pkg: basePkg,
      pins: [pin('1'), pin('2'), pin('1', 'DUP')],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/重复/);
  });

  it('脚号大小写视为同号（A1 与 a1 重复）', () => {
    const r = validateCustomPartDraft({ mpn: 'X', category: 'ic', pkg: basePkg, pins: [pin('A1'), pin('a1')] });
    expect(r.ok).toBe(false);
  });

  it('尺寸 NaN / Infinity / 负数拒绝', () => {
    for (const bad of [NaN, Infinity, -1, 0]) {
      const r = validateCustomPartDraft({ mpn: 'X', category: 'ic', pins: [pin('1')], pkg: { ...basePkg, bodyW: bad } });
      expect(r.ok).toBe(false);
    }
  });

  it('manual 族必须有焊盘表且焊盘号唯一', () => {
    const noPads = validateCustomPartDraft({ mpn: 'X', category: 'ic', pins: [pin('1')], pkg: { ...basePkg, family: 'manual' } });
    expect(noPads.ok).toBe(false);
    const dup = validateCustomPartDraft({
      mpn: 'X', category: 'ic', pins: [pin('1')],
      pkg: { ...basePkg, family: 'manual', manualPads: [{ num: '1', x: 0, y: 0, w: 1, h: 1 }, { num: '1', x: 2, y: 0, w: 1, h: 1 }] },
    });
    expect(dup.ok).toBe(false);
  });

  it('合法草稿通过（含机械图参数）', () => {
    const r = validateCustomPartDraft({
      mpn: 'TPS563201', category: 'power', pins: [pin('1', 'GND', 'power_in'), pin('2', 'SW'), pin('3', 'VIN', 'power_in')],
      pkg: { ...basePkg, family: 'sot', padLen: 1.0, padWidth: 0.6, leadSpan: 2.8, heightMm: 1.45 },
    });
    expect(r.ok).toBe(true);
  });

  it('family enum 覆盖 UI 全部选项（Prompt 由此动态构建，不漂移）', () => {
    expect(CUSTOM_FAMILIES).toContain('bga');
    expect(CUSTOM_FAMILIES).toContain('to220');
    expect(CUSTOM_FAMILIES.length).toBe(11);
  });
});

describe('封装机械图参数 → 真实封装/3D', () => {
  it('padLen/padWidth/leadSpan 覆盖合成焊盘（dual 族左右排）', () => {
    const fp = buildCustomFootprint({ ...basePkg, padLen: 1.6, padWidth: 0.55, leadSpan: 7.0 }, 8)!;
    const leftRow = fp.pads.filter((p) => p.x < 0);
    expect(leftRow.length).toBe(4);
    for (const p of leftRow) {
      expect(p.w).toBeCloseTo(1.6, 5);          // 沿引脚方向 = padLen
      expect(p.h).toBeCloseTo(0.55, 5);         // 垂直方向 = padWidth
      expect(Math.abs(p.x)).toBeCloseTo((7.0 - 1.6) / 2, 5);   // 行心距由 leadSpan 决定
    }
  });

  it('heightMm 透传到 PadFootprint（3D 参数化模型取真实高度）', () => {
    const fp = buildCustomFootprint({ ...basePkg, heightMm: 1.75 }, 8)!;
    expect(fp.heightMm).toBe(1.75);
  });

  it('未提供机械图参数时按族规则生成（不发明数值）', () => {
    const a = buildCustomFootprint(basePkg, 8)!;
    const b = buildCustomFootprint({ ...basePkg }, 8)!;
    expect(a.pads.map((p) => [p.x, p.w])).toEqual(b.pads.map((p) => [p.x, p.w]));
    expect(a.heightMm).toBeUndefined();
  });
});

describe('定制符号：电源排不再 3 脚硬上限', () => {
  it('6 个 VDD 全部留在顶部且相邻分组', () => {
    const pins: CustomPin[] = [
      ...[1, 2, 3, 4, 5, 6].map((i) => pin(String(i), 'VDD', 'power_in')),
      pin('7', 'VBAT', 'power_in'),
      pin('8', 'GND', 'power_in'),
      pin('9', 'PA0', 'bidirectional'),
    ];
    const sym = buildCustomSymbol(pins)!;
    // 顶排引脚：tip 在本体上方且引脚线垂直（tipY < endY，向下指向本体）
    const upFacing = sym.pins.filter((p) => p.tipX === p.endX && p.tipY < p.endY);
    // 顶部至少 7 脚（6×VDD + VBAT），不再被挪到左侧
    expect(upFacing.length).toBeGreaterThanOrEqual(7);
    // 同名 VDD 分组相邻：按 x 排序后 6 个 VDD 是连续区段（不与 VBAT 交错）
    const upSorted = [...upFacing].sort((a, b) => a.tipX - b.tipX);
    const names = upSorted.map((p) => p.name);
    const first = names.indexOf('VDD'), last = names.lastIndexOf('VDD');
    expect(names.filter((n) => n === 'VDD')).toHaveLength(6);
    expect(last - first).toBe(5);
  });
});

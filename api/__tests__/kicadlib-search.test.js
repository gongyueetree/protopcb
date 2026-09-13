/**
 * KiCad 官方库检索的库排序：器件名 → 所在库的提示表
 * （WS2812 在 LED 库、ESP32 在 RF_Module 库，名字与库名对不上，
 *   只按"库名包含关键词"排序会把它们排到预算之外，永远搜不到。）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../kicadlib.js', import.meta.url), 'utf8');

/** 从源码里取出 PART_HINTS 表，避免测试与实现各写一份 */
function partHints() {
  const m = src.match(/const PART_HINTS = \[([\s\S]*?)\n\s{8}\];/);
  if (!m) throw new Error('PART_HINTS 未找到');
  return new Function(`return [${m[1]}]`)();
}

describe('器件名 → 库 提示表', () => {
  const hints = partHints();
  const libFor = (q) => hints.find(([re]) => re.test(q))?.[1];

  it('WS2812 / SK6812 指向 LED 库', () => {
    expect(libFor('ws2812')).toBeTruthy();
    expect(libFor('ws2812').test('LED')).toBe(true);
    expect(libFor('sk6812').test('LED')).toBe(true);
  });

  it('ESP32 指向 RF_Module 库', () => {
    expect(libFor('esp32-wroom-32').test('RF_Module')).toBe(true);
  });

  it('CH340 指向 Interface_USB 库', () => {
    expect(libFor('ch340c').test('Interface_USB')).toBe(true);
  });

  it('STM32 指向 MCU_ST_STM32 系列库', () => {
    expect(libFor('stm32f103c8t6').test('MCU_ST_STM32F1')).toBe(true);
  });

  it('无提示的查询返回 undefined（不硬凑）', () => {
    expect(libFor('zzz-unknown-part')).toBeUndefined();
  });
});

describe('零命中时扩展检索预算', () => {
  it('源码里确实有扩展预算与"无命中才继续"的条件', () => {
    expect(src).toMatch(/EXTENDED_BUDGET/);
    expect(src).toMatch(/hits\.length > 0 \|\| li >= EXTENDED_BUDGET/);
  });
});

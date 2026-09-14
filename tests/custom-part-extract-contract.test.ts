/**
 * 定制器件 AI 提取契约：服务端 prompt / 校验器 / 前端 applyExtract 同一 schema
 * （回归：prompt 搬到服务端时尺寸字段写到了根对象，前端 package.* 一个都收不到）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseExtraction, extractionPromptShape } from '../src/design-core/custom-part-extract-contract';
import { CUSTOM_FAMILIES, CUSTOM_CATEGORIES, buildCustomFootprint } from '../src/design-core/custom-lib';
import { AI_OPERATIONS } from '../api/_lib/ai-operations.js';

const enums = JSON.parse(readFileSync(new URL('../contracts/custom-part-enums.json', import.meta.url), 'utf8'));

describe('枚举同源', () => {
  it('前端 CUSTOM_FAMILIES / CUSTOM_CATEGORIES 与 contracts JSON 完全一致', () => {
    expect([...CUSTOM_FAMILIES]).toEqual(enums.families);
    expect([...CUSTOM_CATEGORIES]).toEqual(enums.categories);
  });
  it('服务端 part.extract 的 prompt 使用同一枚举（不再各维护一份）', () => {
    const prompt = AI_OPERATIONS['part.extract'].buildPrompt({ mode: 'text', text: 'x' });
    expect(prompt).toContain(`"family":"${enums.families.join('|')}"`);
    expect(prompt).toContain(`"category":"${enums.categories.join('|')}"`);
  });
  it('服务端 prompt 把尺寸放在 package{} 下（前端只认这里）', () => {
    const prompt = AI_OPERATIONS['part.extract'].buildPrompt({ mode: 'text', text: 'x' });
    expect(prompt).toMatch(/"package":\{"family"/);
    expect(prompt).not.toMatch(/^\{"mpn"[^}]*"bodyW"/m);
  });
  it('前端契约的形状说明与服务端 prompt 描述同一结构', () => {
    expect(extractionPromptShape()).toMatch(/"package":\{"family"/);
  });
});

describe('模型返回尺寸 → 前端真的拿到几何', () => {
  const modelOutput = {
    mpn: 'CH340C', description: 'USB 转串口', category: 'ic',
    pins: [{ num: 1, name: 'GND', type: 'power_in', side: 'bottom' }, { num: '16', name: 'VCC', type: 'power_in', side: 'top' }],
    package: { family: 'dual', bodyW: 10, bodyH: 4, pitch: 1.27, leadSpan: 6, padLen: 1.5, padWidth: 0.6, heightMm: 1.75 },
  };

  it('契约校验通过，package 完整保留', () => {
    const r = parseExtraction(modelOutput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.package?.family).toBe('dual');
    expect(r.data.package?.bodyW).toBe(10);
    expect(r.data.package?.leadSpan).toBe(6);
    expect(r.data.pins[0].num).toBe('1');   // 数字脚号规范化为字符串
  });

  it('buildCustomFootprint 用这些尺寸得到正确几何', () => {
    const r = parseExtraction(modelOutput);
    if (!r.ok) throw new Error(r.error);
    const pk = r.data.package!;
    const fp = buildCustomFootprint({
      family: pk.family, bodyW: pk.bodyW!, bodyH: pk.bodyH!, pitch: pk.pitch!,
      leadSpan: pk.leadSpan, padLen: pk.padLen, padWidth: pk.padWidth, heightMm: pk.heightMm,
    }, 16);
    expect(fp).not.toBeNull();
    // dual 族的引脚沿长边排布，builder 会按自己的轴向约定摆放；这里只断言尺寸本身到达了几何层
    expect([fp!.bodyW, fp!.bodyH].sort((a, b) => a - b)).toEqual([4, 10]);
    expect(fp!.pads).toHaveLength(16);
    // leadSpan=6 → 两排焊盘中心间距应接近 6mm（不是按本体尺寸估的 ~4）
    const xs = fp!.pads.map((p) => p.x), ys = fp!.pads.map((p) => p.y);
    const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
    // 焊盘中心间距由 leadSpan 决定（builder 会扣掉半个焊盘长度），必须落在 (bodyH, leadSpan] 之间，
    // 说明真实机械参数到达了几何层，而不是按本体尺寸估算
    const rowSpacing = Math.min(spanX, spanY);
    expect(rowSpacing).toBeGreaterThan(4);
    expect(rowSpacing).toBeLessThanOrEqual(6);
  });

  it('未知 family 回落 manual、null 尺寸变 undefined，不整条拒绝', () => {
    const r = parseExtraction({ package: { family: 'weird', bodyW: null, bodyH: 4 } });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.package?.family).toBe('manual'); expect(r.data.package?.bodyW).toBeUndefined(); }
  });

  it('旧的错误结构（尺寸在根对象）不会被误认为有尺寸', () => {
    const r = parseExtraction({ mpn: 'X', family: 'dual', bodyW: 10, bodyH: 4 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.package).toBeUndefined();
  });
});

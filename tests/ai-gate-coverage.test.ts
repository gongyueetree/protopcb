/**
 * AI 门禁覆盖：每一处 AI 调用点都必须带 capability 并过门禁
 * （漏一处，匿名用户就会在那里看到原始错误而不是登录引导）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CREDIT_COST } from '../src/design-core/entitlements';
import { CREDIT_COST as SERVER_COST } from '../api/_lib/credit-cost.js';

const SRC = new URL('../src', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}
const files = walk(SRC).map((p) => ({ p, text: readFileSync(p, 'utf8') }));

describe('前后端价目表一致', () => {
  it('两侧的能力集合与单价完全相同（服务端为准，前端只用于提示）', () => {
    expect(Object.keys(SERVER_COST).sort()).toEqual(Object.keys(CREDIT_COST).sort());
    for (const [k, v] of Object.entries(CREDIT_COST)) {
      expect(SERVER_COST[k]).toBe(v);
    }
  });
});

describe('所有 AI 调用点都过门禁', () => {
  /** 直接调 geminiComplete 的业务文件（provider 自身与测试除外） */
  const callers = files.filter(({ p, text }) =>
    /geminiComplete\s*\(/.test(text)
    && !p.includes('/providers/gemini/')
    && !p.includes('__tests__') && !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'));

  it('确实找到了若干调用点（防止正则失效导致空跑通过）', () => {
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  for (const { p } of callers) {
    const rel = p.split('/src/')[1];
    it(`${rel}：UI 组件过门禁 / 服务模块显式传 capability`, () => {
      const text = readFileSync(p, 'utf8');
      const isComponent = /\.tsx$/.test(p);
      if (isComponent) {
        // 组件层负责展示登录/额度提示
        expect(/useAiGate|guard\(|checkCap\(|check\('/.test(text)).toBe(true);
      } else {
        // 服务层不做 UI，但必须把能力标识传下去，否则服务端按默认类目扣费
        expect(/geminiComplete\([\s\S]*?['"`](scheme\.|subcircuit\.|advisor\.|block\.|part\.|bom\.|symbol\.)/.test(text)
          || /check\('/.test(text)).toBe(true);
      }
    });
  }

  it('直接 fetch(\'/api/gemini\') 的地方必须带 capability 与 credentials', () => {
    for (const { p, text } of files) {
      if (p.includes('/providers/gemini/')) continue;
      if (!text.includes("fetch('/api/gemini'")) continue;
      expect(text, p).toMatch(/capability:/);
      expect(text, p).toMatch(/credentials: 'include'/);
    }
  });
});

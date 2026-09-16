/**
 * AI 调用入口唯一性：生产代码只能通过 aiRequest() 调 AI。
 *
 * 为什么不再按文件 grep "capability:"：同一文件里一处合规、另一处裸 fetch 会被漏掉。
 * 现在的规则更简单也更硬：生产代码里 fetch('/api/gemini') 与 geminiComplete( 必须为 0，
 * 所有 AI 调用都经 aiRequest()，而 aiRequest 只在一个文件里实现。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CREDIT_COST } from '../../src/design-core/entitlements';
import { OPERATION_COST } from '../../api/_lib/ai-operations.js';

const SRC = new URL('../../src', import.meta.url).pathname;
const AI_CLIENT = 'providers/ai-client/index.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.includes('__tests__')) out.push(p);
  }
  return out;
}
const files = walk(SRC).map((p) => ({ rel: p.split('/src/')[1], text: readFileSync(p, 'utf8') }));

describe('价目表唯一来源：contracts/ai-operations.json', () => {
  const contract = JSON.parse(readFileSync(new URL('../../contracts/ai-operations.json', import.meta.url), 'utf8'));
  const fromContract = Object.fromEntries(Object.entries(contract.operations).map(([k, v]) => [k, (v as { cost: number }).cost]));
  it('服务端注册表与前端提示表都等于 contract（谁也不许自己手写数字）', () => {
    expect(OPERATION_COST).toEqual(fromContract);
    expect(CREDIT_COST).toEqual(fromContract);
  });
  it('旧的第二份价目表 api/_lib/credit-cost.js 已删除', () => {
    expect(() => readFileSync(new URL('../../api/_lib/credit-cost.js', import.meta.url))).toThrow();
  });
});

describe('AI 调用入口唯一', () => {
  it("生产代码里 fetch('/api/gemini') 为 0（旧接口只留管理员兼容）", () => {
    const offenders = files.filter(({ text }) => /fetch\(\s*['"`]\/api\/gemini(?!\?path=status)/.test(text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("生产代码里直接 fetch('/api/ai') 只允许出现在 ai-client 里", () => {
    const offenders = files.filter(({ rel, text }) => rel !== AI_CLIENT && /fetch\(\s*['"`]\/api\/ai['"`]/.test(text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('geminiComplete( 在生产代码里为 0（已被 aiRequest 取代）', () => {
    const offenders = files.filter(({ text }) => /\bgeminiComplete\s*\(/.test(text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('确实存在若干 aiRequest 调用点（防止规则失效导致空跑通过）', () => {
    const callers = files.filter(({ rel, text }) => rel !== AI_CLIENT && /\baiRequest\s*\(/.test(text));
    expect(callers.length).toBeGreaterThanOrEqual(5);
  });

  it('每个 aiRequest 调用的 operation 都在注册表里（未知操作服务端会 400）', () => {
    const ops = new Set(Object.keys(OPERATION_COST));
    for (const { rel, text } of files) {
      if (rel === AI_CLIENT) continue;
      for (const m of text.matchAll(/aiRequest\(\s*['"`]([a-z.]+)['"`]/g)) {
        expect(ops.has(m[1]), `${rel} 使用了未注册的操作 ${m[1]}`).toBe(true);
      }
    }
  });

  it('客户端不持有任何 AI prompt 模板（prompt 全部在服务端注册表）', () => {
    // 标志性片段：严格输出 JSON —— 这是我们所有 prompt 的固定结尾
    const offenders = files.filter(({ text }) => /严格输出 JSON/.test(text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

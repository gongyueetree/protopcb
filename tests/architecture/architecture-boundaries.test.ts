/**
 * 架构边界门禁 —— 这是本仓库唯一允许"扫源码"的测试用途：
 *   design-core 是纯 Domain，不得 import providers / modules / state / react
 *   生产代码不得 import providers/mock
 *   AI prompt 只能在服务端注册表；生产代码不得 POST /api/gemini
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../../src', import.meta.url).pathname;
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.includes('__tests__')) out.push(p);
  }
  return out;
}
const files = walk(SRC).map((p) => ({ rel: p.split('/src/')[1], text: readFileSync(p, 'utf8') }));
const imports = (text: string) => [...text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);

describe('design-core 是纯 Domain', () => {
  const domain = files.filter((f) => f.rel.startsWith('design-core/'));
  it('存在（防止 walk 失效导致空跑）', () => expect(domain.length).toBeGreaterThan(20));

  for (const forbidden of ['providers/', '/modules/', '/state/', "'react'", 'zustand']) {
    it(`不 import ${forbidden}`, () => {
      const offenders = domain.filter((f) => imports(f.text).some((i) => i.includes(forbidden.replace(/'/g, ''))))
        .map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  }
});

describe('Application 层不依赖 UI', () => {
  it('src/application/** 不 import src/modules/**', () => {
    const offenders = files.filter((f) => f.rel.startsWith('application/'))
      .filter((f) => imports(f.text).some((i) => /(^|\/)modules(\/|$)/.test(i)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
  it('导入服务返回结构化结果，不自己弹提示', () => {
    const src = files.find((f) => f.rel === 'application/project-import.ts')!.text;
    expect(src).toMatch(/export interface ImportResult/);
    expect(src).not.toMatch(/dialogs\.toast\(/);
  });
});

describe('生产代码不依赖 Mock', () => {
  it('providers/mock 只允许被 providers/factory 装配（demo 模式）', () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith('providers/mock/') && f.rel !== 'providers/factory.ts')
      .filter((f) => imports(f.text).some((i) => i.includes('providers/mock')))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

describe('AI 边界', () => {
  it('生产代码不 POST /api/gemini（唯一入口 aiRequest → /api/ai）', () => {
    const offenders = files.filter((f) => /fetch\(\s*['"`]\/api\/gemini(?!\?path=status)/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
  it('客户端不持有 AI prompt（"严格输出 JSON" 只应出现在服务端注册表）', () => {
    const offenders = files.filter((f) => /严格输出 JSON/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

describe('Source 不靠字符串猜（显式 source 优先）', () => {
  it('候选显式携带 source 时按 source 写入，且不会被写成 MOCK', async () => {
    const { searchResultToPlaced } = await import('../../src/design-core/document/services');
    const c = searchResultToPlaced({
      componentId: 'whatever_123', mpn: 'X', manufacturer: '-', category: 'ic',
      defaultFootprintName: 'SOIC-8', family: 'IC', description: '', pins: 8, source: 'DIGIKEY',
    }, 'U1');
    expect(c.source).toBe('DIGIKEY');
    expect(c.trust?.level).toBe('VERIFIED');
  });
  it('没有 source 也不是 ezPLM 的真实器件 → 不是 MOCK', async () => {
    const { searchResultToPlaced } = await import('../../src/design-core/document/services');
    const c = searchResultToPlaced({
      componentId: 'kicad_U5', mpn: 'RP2040', manufacturer: '-', category: 'mcu',
      defaultFootprintName: 'QFN-56', family: 'MCU', description: '', pins: 56,
    }, 'U5');
    expect(c.source).not.toBe('MOCK');
  });
});

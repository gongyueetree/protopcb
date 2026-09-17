/**
 * part.extract 的计费口径必须统一：
 * DS2KiCad 成功与 Gemini 兜底**同价同 operationId**，浏览器不能靠直连 ds2kicad 绕开扣费。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import aiHandler from '../ai.js';
import ds2Handler from '../ds2kicad.js';

/* 与 ai-endpoint.test.js 同款的最小请求/响应替身（这两个文件各自独立，不共享状态） */
const UUID = () => '11111111-2222-4333-8444-' + String(Date.now() + Math.floor(Math.random() * 1e6)).padStart(12, '0').slice(-12);

const mockRes = () => ({
  statusCode: 200, headers: {}, body: undefined,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  send(b) { this.body = b; return this; },
  json() { return JSON.parse(this.body); },
});
const req = (over = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, query: {},
  socket: { remoteAddress: '203.0.113.' + Math.floor(Math.random() * 200) }, ...over,
});
const authed = (body) => req({ headers: { 'content-type': 'application/json', authorization: 'Bearer good-token' }, body });


describe('DS2KiCad 与 Gemini 同价', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.EZPLM_AUTH_BASE = 'https://auth.test/api/v1';
    process.env.AI_REQUIRE_AUTH = '1';
    process.env.DS2KICAD_URL = 'https://ds2.test';
  });
  afterEach(() => {
    for (const k of ['GEMINI_API_KEY', 'EZPLM_AUTH_BASE', 'DS2KICAD_URL']) delete process.env[k];
    vi.unstubAllGlobals();
  });

  const runExtract = async (ds2Ok, credits = 100) => {
    const state = { credits };
    vi.stubGlobal('fetch', async (url, init) => {
      const u = String(url);
      if (u.endsWith('/me')) return new Response(JSON.stringify({ data: { userId: 'u1', credits: state.credits } }));
      if (u.endsWith('/credits/consume')) {
        const cost = JSON.parse(init.body).cost;
        // 余额不足时上游拒付（真实账本行为），服务端据此返回 402
        if (state.credits < cost) return new Response(JSON.stringify({ error: 'insufficient', code: 'INSUFFICIENT_CREDITS' }), { status: 402 });
        state.credits -= cost;
        return new Response(JSON.stringify({ remaining: state.credits }));
      }
      if (u.includes('ds2.test')) {
        return ds2Ok
          ? new Response(JSON.stringify({ mpn: 'CH340C', pins: [] }))
          : new Response('upstream down', { status: 503 });
      }
      if (u.includes('generativelanguage')) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }));
      return new Response('{}');
    });
    const res = mockRes();
    await aiHandler(authed({
      operation: 'part.extract', operationId: UUID(),
      input: { mode: 'pdf', lang: 'zh' }, pdfBase64: 'JVBERi0xLjQK', fileName: 'x.pdf',
    }), res);
    return { res, state };
  };

  it('DS2 成功：同样扣 4 Credit（不再是免费）', async () => {
    const { res, state } = await runExtract(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.engine).toBe('ds2kicad');
    expect(body.usage.charged).toBe(4);
    expect(state.credits).toBe(96);
  });

  it('DS2 失败回落 Gemini：仍只扣一次 4 Credit', async () => {
    const { res, state } = await runExtract(false);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.engine).toBeUndefined();
    expect(state.credits).toBe(96);
  });

  it('0 Credit 的注册用户拿不到提取（DS2 路径也不行）', async () => {
    const { res, state } = await runExtract(true, 0);
    expect(res.statusCode).toBe(402);
    expect(state.credits).toBe(0);
  });
});

describe('浏览器不得直连 /api/ds2kicad 做付费提取', () => {
  it('前端源码里没有 ds2kicad.extract 调用', () => {
    const SRC = new URL('../../src', import.meta.url).pathname;
    const walk = (d, out = []) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(p)) out.push(p); } return out; };
    const offenders = walk(SRC).filter((p) => /ds2kicad\.(extract|status)\(/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('匿名直接 POST /api/ds2kicad 仍被拒（端点只对内），且零上游调用', async () => {
    process.env.EZPLM_AUTH_BASE = 'https://auth.test/api/v1';
    let upstream = 0;
    vi.stubGlobal('fetch', async (url) => {
      const u = String(url);
      if (u.endsWith('/me')) return new Response('{}', { status: 401 });
      upstream++;
      return new Response('{}');
    });
    const res = mockRes();
    await ds2Handler(req({ body: { pdfBase64: 'JVBERi0x' } }), res);
    expect(res.statusCode).toBe(401);
    expect(upstream).toBe(0);
    delete process.env.EZPLM_AUTH_BASE;
    vi.unstubAllGlobals();
  });
});

/**
 * 服务端关卡：未登录不能触发任何付费上游调用
 * （前端藏按钮挡不住直接 POST /api/gemini —— 这一层才是真正防乱刷的）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionTokenOf, verifySession } from '../_lib/session.js';
import geminiHandler from '../gemini.js';

const mockRes = () => ({
  statusCode: 200, headers: {}, body: undefined,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  send(b) { this.body = b; return this; },
});
const req = (over = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json' },
  query: {}, body: { prompt: 'hi', capability: 'scheme.generate' },
  socket: { remoteAddress: '203.0.113.9' }, ...over,
});

describe('会话令牌提取', () => {
  it('支持 Authorization: Bearer', () => {
    expect(sessionTokenOf({ headers: { authorization: 'Bearer abc123' } })).toBe('abc123');
  });
  it('支持 ezplm_session / eehub_session Cookie', () => {
    expect(sessionTokenOf({ headers: { cookie: 'a=1; ezplm_session=tok1; b=2' } })).toBe('tok1');
    expect(sessionTokenOf({ headers: { cookie: 'eehub_session=tok2' } })).toBe('tok2');
  });
  it('没有会话时返回空串', () => {
    expect(sessionTokenOf({ headers: {} })).toBe('');
  });
});

describe('未登录一律拒绝', () => {
  it('无令牌 → LOGIN_REQUIRED', async () => {
    const s = await verifySession({ headers: {} });
    expect(s.ok).toBe(false);
    expect(s.code).toBe('LOGIN_REQUIRED');
    expect(s.status).toBe(401);
  });

  it('有令牌但鉴权服务未配置 → 拒绝（宁可全不可用，也不敞开付费接口）', async () => {
    const prev = process.env.EZPLM_AUTH_BASE;
    delete process.env.EZPLM_AUTH_BASE;
    const s = await verifySession({ headers: { authorization: 'Bearer x' } });
    expect(s.ok).toBe(false);
    expect(s.code).toBe('BACKEND_NOT_CONNECTED');
    if (prev) process.env.EZPLM_AUTH_BASE = prev;
  });
});

describe('/api/gemini 的关卡在上游调用之前', () => {
  let fetchCalls;
  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal('fetch', async (url) => { fetchCalls.push(String(url)); return new Response('{}'); });
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_REQUIRE_AUTH = '1';
    delete process.env.EZPLM_AUTH_BASE;
  });
  afterEach(() => { delete process.env.GEMINI_API_KEY; delete process.env.AI_REQUIRE_AUTH; });

  it('匿名 POST 被拒，且**零次**上游调用（不产生任何费用）', async () => {
    const res = mockRes();
    await geminiHandler(req(), res);
    expect([401, 402, 503]).toContain(res.statusCode);
    expect(fetchCalls.filter((u) => u.includes('generativelanguage'))).toHaveLength(0);
  });

  it('拒绝响应带机器可读的 code，供前端给出对应引导', async () => {
    const res = mockRes();
    await geminiHandler(req(), res);
    const body = JSON.parse(res.body);
    expect(['LOGIN_REQUIRED', 'BACKEND_NOT_CONNECTED']).toContain(body.code);
  });
});

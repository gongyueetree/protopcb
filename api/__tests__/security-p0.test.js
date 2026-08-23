/**
 * P0 安全回归测试
 *  1. 匿名 GET /api/gemini?path=diag 不能触发真实上游调用
 *  2. 同一 IP 轮换 x-cc-session 不能绕过配额（callerKey 以 IP 为主体）
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { callerKey, acquire, LIMITS } from '../_lib/guard.js';
import geminiHandler from '../gemini.js';

function mockReq({ headers = {}, method = 'GET', query = {}, body = undefined, ip = '203.0.113.7' } = {}) {
  return { headers, method, query, body, socket: { remoteAddress: ip } };
}
function mockRes() {
  const r = {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
  };
  return r;
}

describe('callerKey：客户端 session 不能替代 IP 成为配额主体', () => {
  it('轮换 x-cc-session 得到的配额键相同（均落到同一 IP）', () => {
    const k1 = callerKey(mockReq({ headers: { 'x-cc-session': 'a1' } }));
    const k2 = callerKey(mockReq({ headers: { 'x-cc-session': 'a2' } }));
    const k3 = callerKey(mockReq({ headers: {} }));
    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
    expect(k1.startsWith('ip:')).toBe(true);
  });

  it('x-forwarded-for 客户端伪造前缀不改变主体（取链尾公网地址）', () => {
    const spoofed = callerKey(mockReq({ headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.9' } }));
    const spoofed2 = callerKey(mockReq({ headers: { 'x-forwarded-for': '5.6.7.8, 198.51.100.9' } }));
    expect(spoofed).toBe(spoofed2);        // 伪造前缀无效
    expect(spoofed).toBe('ip:198.51.100.9');
  });

  it('服务端验证过的身份才能切换主体', () => {
    const k = callerKey(mockReq({}), { userId: 'u1', tenantId: 't1' });
    expect(k).toBe('u:t1:u1');
  });

  it('同一 IP 轮换 session 打满配额后，换新 session 依然 429', () => {
    const scope = 'test-bypass-' + Math.random();
    const leases = [];
    let denied = null;
    for (let i = 0; i < LIMITS.perWindow + 5; i++) {
      const r = acquire(mockReq({ headers: { 'x-cc-session': 's' + i } }), scope);
      if (r.ok) { leases.push(r); r.release(); } else { denied = r; break; }
    }
    expect(denied).not.toBeNull();
    expect(denied.status).toBe(429);
    expect(leases.length).toBe(LIMITS.perWindow);
  });
});

describe('Gemini diag：匿名不可触发真实付费调用', () => {
  const realFetch = globalThis.fetch;
  let fetchCalls;
  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal('fetch', async (url, _init) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '正常' }] } }] }), { status: 200 });
    });
    process.env.GEMINI_API_KEY = 'test-key-should-not-be-used';
    delete process.env.ADMIN_DIAG_TOKEN;
  });
  afterEach(() => {
    vi.stubGlobal('fetch', realFetch);
    delete process.env.GEMINI_API_KEY;
    delete process.env.ADMIN_DIAG_TOKEN;
  });

  it('无 admin token：diag 被拒绝，且没有发起任何上游 fetch', async () => {
    const res = mockRes();
    await geminiHandler(mockReq({ method: 'GET', query: { path: 'diag' } }), res);
    expect([403, 404]).toContain(res.statusCode);
    expect(fetchCalls.length).toBe(0);      // 关键断言：0 次上游调用 = 0 次计费
  });

  it('伪造 x-admin-token（服务端未配置 token）依然拒绝', async () => {
    const res = mockRes();
    await geminiHandler(mockReq({ method: 'GET', query: { path: 'diag' }, headers: { 'x-admin-token': 'whatever-i-guess' } }), res);
    expect([403, 404]).toContain(res.statusCode);
    expect(fetchCalls.length).toBe(0);
  });

  it('配置了正确 token 时 diag 可用（并经过限流路径）', async () => {
    process.env.ADMIN_DIAG_TOKEN = 'a-strong-admin-token-16+';
    const res = mockRes();
    await geminiHandler(mockReq({ method: 'GET', query: { path: 'diag' }, headers: { 'x-admin-token': 'a-strong-admin-token-16+' } }), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(fetchCalls.length).toBe(1);
  });

  it('status 保持免费可用（不打上游）', async () => {
    const res = mockRes();
    await geminiHandler(mockReq({ method: 'GET', query: { path: 'status' } }), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).configured).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });
});

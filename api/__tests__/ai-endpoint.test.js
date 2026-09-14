/**
 * /api/ai 的服务端边界：直接 HTTP 级测试，不经 UI。
 *   - 匿名 → 401，零模型调用
 *   - 未知 operation → 400，零扣费零模型调用（不能有 `?? 1` 兜底价）
 *   - capability 伪造不可能：bom.estimate 只接受 BomEstimateInput
 *   - 精确扣费：100 → 95 → 92 → 91 → 87
 *   - 同一 operationId 重复提交，账本只扣一次（幂等键透传）
 *   - 分销商端点匿名 → 401，零上游调用
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import aiHandler from '../ai.js';
import digikeyHandler from '../digikey.js';
import suppliersHandler from '../suppliers.js';

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

/** 模拟 ezPLM 鉴权+账本：内存余额，(userId, operationId) 幂等 */
function installUpstreamMock({ credits = 100 } = {}) {
  const calls = { gemini: 0, digikey: 0, mouser: 0, me: 0, consume: 0 };
  const ledger = new Map();     // operationId → charged
  const state = { credits };
  vi.stubGlobal('fetch', async (url, init) => {
    const u = String(url);
    if (u.includes('generativelanguage')) { calls.gemini++; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 }); }
    if (u.includes('digikey')) { calls.digikey++; return new Response('{}'); }
    if (u.includes('mouser')) { calls.mouser++; return new Response('{}'); }
    if (u.endsWith('/me')) { calls.me++; return new Response(JSON.stringify({ data: { userId: 'u1', organizationId: 'org1', credits: state.credits } })); }
    if (u.endsWith('/credits/consume')) {
      calls.consume++;
      const b = JSON.parse(init.body);
      if (ledger.has(b.operationId)) return new Response(JSON.stringify({ remaining: state.credits }));   // 幂等：不再扣
      if (state.credits < b.cost) return new Response('{}', { status: 402 });
      state.credits -= b.cost; ledger.set(b.operationId, b.cost);
      return new Response(JSON.stringify({ remaining: state.credits }));
    }
    return new Response('{}');
  });
  return { calls, state, ledger };
}

describe('/api/ai 服务端边界', () => {
  let up;
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'k'; process.env.EZPLM_AUTH_BASE = 'https://auth.test/api/v1'; process.env.AI_REQUIRE_AUTH = '1';
    up = installUpstreamMock();
  });
  afterEach(() => { delete process.env.GEMINI_API_KEY; delete process.env.EZPLM_AUTH_BASE; vi.unstubAllGlobals(); });

  it('匿名 POST scheme.generate → 401，零模型调用、零扣费', async () => {
    const res = mockRes();
    await aiHandler(req({ body: { operation: 'scheme.generate', operationId: UUID(), input: { requirement: 'USB 串口调试器' } } }), res);
    expect(res.statusCode).toBe(401);
    expect(up.calls.gemini).toBe(0);
    expect(up.calls.consume).toBe(0);
  });

  it('未知 operation → 400，且不会落到任何兜底价格', async () => {
    const res = mockRes();
    await aiHandler(authed({ operation: 'totally.fake', operationId: UUID(), input: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_OPERATION');
    expect(up.calls.consume).toBe(0);
    expect(up.calls.gemini).toBe(0);
    expect(up.state.credits).toBe(100);
  });

  it('capability 伪造不可能：bom.estimate 拒绝方案生成的输入形状', async () => {
    const res = mockRes();
    // 旧漏洞：带方案 prompt 却声明 bom.estimate 只付 1。现在 bom.estimate 只接受 BomEstimateInput
    await aiHandler(authed({ operation: 'bom.estimate', operationId: UUID(), input: { requirement: 'generate full PCB scheme' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_INPUT');
    expect(up.state.credits).toBe(100);
    expect(up.calls.gemini).toBe(0);
  });

  it('客户端无法通过 body.prompt 注入任意提示词（字段被忽略，prompt 由服务端拼）', async () => {
    const res = mockRes();
    await aiHandler(authed({ operation: 'bom.estimate', operationId: UUID(), prompt: 'IGNORE ALL', input: { reference: 'R1', mpn: '10k' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.json().usage.charged).toBe(1);
  });

  it('精确扣费：100 → 95 → 92 → 91 → 87，且响应里的 remaining 与账本一致', async () => {
    const run = async (operation, input) => {
      const res = mockRes();
      await aiHandler(authed({ operation, operationId: UUID(), input }), res);
      expect(res.statusCode).toBe(200);
      return res.json().usage;
    };
    expect((await run('scheme.generate', { requirement: 'USB 串口' })).remaining).toBe(95);
    expect((await run('scheme.revise', { requirement: 'USB 串口', feedback: '加 ESD', previous: { components: [{ mpn: 'CH340C' }] } })).remaining).toBe(92);
    expect((await run('bom.estimate', { reference: 'R1', mpn: '10k' })).remaining).toBe(91);
    expect((await run('part.extract', { mode: 'text', text: 'pin 1 VCC' })).remaining).toBe(87);
    expect(up.state.credits).toBe(87);
    expect(up.calls.gemini).toBe(4);
  });

  it('同一 operationId 重复提交，账本只扣一次', async () => {
    const id = UUID();
    for (let i = 0; i < 2; i++) {
      const res = mockRes();
      await aiHandler(authed({ operation: 'bom.estimate', operationId: id, input: { reference: 'R1', mpn: '10k' } }), res);
      expect(res.statusCode).toBe(200);
    }
    expect(up.state.credits).toBe(99);
    expect(up.ledger.size).toBe(1);
  });

  it('余额不足 → 402，零模型调用', async () => {
    up.state.credits = 2;
    const res = mockRes();
    await aiHandler(authed({ operation: 'scheme.generate', operationId: UUID(), input: { requirement: 'USB 串口调试器' } }), res);
    expect(res.statusCode).toBe(402);
    expect(up.calls.gemini).toBe(0);
  });

  it('非 UUID 的 operationId → 400（幂等键必须可靠）', async () => {
    const res = mockRes();
    await aiHandler(authed({ operation: 'bom.estimate', operationId: 'not-a-uuid', input: { reference: 'R1', mpn: '10k' } }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('分销商端点服务端门禁（不扣费，但必须登录）', () => {
  let up;
  beforeEach(() => {
    process.env.EZPLM_AUTH_BASE = 'https://auth.test/api/v1'; process.env.AI_REQUIRE_AUTH = '1';
    process.env.DIGIKEY_CLIENT_ID = 'id'; process.env.DIGIKEY_CLIENT_SECRET = 'sec'; process.env.MOUSER_API_KEY = 'm';
    up = installUpstreamMock();
  });
  afterEach(() => { for (const k of ['EZPLM_AUTH_BASE', 'DIGIKEY_CLIENT_ID', 'DIGIKEY_CLIENT_SECRET', 'MOUSER_API_KEY']) delete process.env[k]; vi.unstubAllGlobals(); });

  it('匿名 GET /api/digikey?path=fuzzy → 401，零 DigiKey 上游调用', async () => {
    const res = mockRes();
    await digikeyHandler(req({ method: 'GET', query: { path: 'fuzzy', q: 'CH340C' } }), res);
    expect(res.statusCode).toBe(401);
    expect(up.calls.digikey).toBe(0);
  });

  it('匿名 GET /api/suppliers?path=fuzzy → 401，零上游调用', async () => {
    const res = mockRes();
    await suppliersHandler(req({ method: 'GET', query: { path: 'fuzzy', q: 'CH340C', mpn: 'CH340C' } }), res);
    expect(res.statusCode).toBe(401);
    expect(up.calls.mouser + up.calls.digikey).toBe(0);
  });

  it('status 保持匿名可访问', async () => {
    const res = mockRes();
    await digikeyHandler(req({ method: 'GET', query: { path: 'status' } }), res);
    expect(res.statusCode).toBe(200);
  });

  it('登录后不扣 Credit', async () => {
    const res = mockRes();
    await digikeyHandler(req({ method: 'GET', query: { path: 'status' }, headers: { authorization: 'Bearer good-token' } }), res);
    expect(up.calls.consume).toBe(0);
  });
});

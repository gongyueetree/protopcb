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
// safeFetch 会真的做 DNS 解析（SSRF 防护）；测试里把示例域名解析到公网地址
vi.mock('node:dns/promises', () => ({
  lookup: async (host) => (host === 'vendor.example' ? [{ address: '93.184.216.34', family: 4 }] : Promise.reject(new Error('ENOTFOUND'))),
}));
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
    expect((await run('part.extract', { mode: 'text', text: 'Pin 1 VCC, Pin 2 GND, Pin 3 OUT. SOIC-8 package 3.9x4.9mm' })).remaining).toBe(87);
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

describe('分销商端点：匿名可用（限频），不扣 Credit', () => {
  let up;
  beforeEach(() => {
    process.env.EZPLM_AUTH_BASE = 'https://auth.test/api/v1'; process.env.AI_REQUIRE_AUTH = '1';
    process.env.DIGIKEY_CLIENT_ID = 'id'; process.env.DIGIKEY_CLIENT_SECRET = 'sec'; process.env.MOUSER_API_KEY = 'm';
    up = installUpstreamMock();
  });
  afterEach(() => { for (const k of ['EZPLM_AUTH_BASE', 'DIGIKEY_CLIENT_ID', 'DIGIKEY_CLIENT_SECRET', 'MOUSER_API_KEY']) delete process.env[k]; vi.unstubAllGlobals(); });

  it('匿名检索不再 401（这类查询不耗 AI Token，未登录也要能选型）', async () => {
    const res = mockRes();
    await digikeyHandler(req({ method: 'GET', query: { path: 'fuzzy', q: 'CH340C' } }), res);
    expect(res.statusCode).not.toBe(401);
  });

  it('匿名 /api/suppliers 同样放行', async () => {
    const res = mockRes();
    await suppliersHandler(req({ method: 'GET', query: { path: 'fuzzy', q: 'CH340C', mpn: 'CH340C' } }), res);
    expect(res.statusCode).not.toBe(401);
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

describe('part.extract 判别校验与扣费顺序（P0-5 / P0-6）', () => {
  let up;
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'k'; process.env.EZPLM_AUTH_BASE = 'https://auth.test/api/v1'; process.env.AI_REQUIRE_AUTH = '1';
    up = installUpstreamMock();
  });
  afterEach(() => { delete process.env.GEMINI_API_KEY; delete process.env.EZPLM_AUTH_BASE; vi.unstubAllGlobals(); });

  const extract = async (input, extra = {}) => {
    const res = mockRes();
    await aiHandler(authed({ operation: 'part.extract', operationId: UUID(), input, ...extra }), res);
    return res;
  };

  it('input={} → 400，零扣费（此前会免费空转一次模型）', async () => {
    const res = await extract({});
    expect(res.statusCode).toBe(400);
    expect(up.state.credits).toBe(100);
    expect(up.calls.gemini).toBe(0);
  });

  it('mode=text 但没有正文 → 400', async () => {
    expect((await extract({ mode: 'text' })).statusCode).toBe(400);
    expect((await extract({ mode: 'text', text: 'short' })).statusCode).toBe(400);
  });

  it('mode=image 但没有图片附件 → 400', async () => {
    expect((await extract({ mode: 'image' })).statusCode).toBe(400);
  });

  it('mode=url 必须是 https', async () => {
    expect((await extract({ mode: 'url', url: 'http://x.com/a.pdf' })).statusCode).toBe(400);
    expect((await extract({ mode: 'url', url: 'ftp://x.com/a.pdf' })).statusCode).toBe(400);
  });

  it('图片超限 → 413，零扣费', async () => {
    const big = 'A'.repeat(9 * 1024 * 1024);   // ~6.75MB 解码后，超过 5MB 上限
    const res = await extract({ mode: 'image' }, { imageBase64: big, imageMime: 'image/png' });
    expect(res.statusCode).toBe(413);
    expect(up.state.credits).toBe(100);
  });

  it('非法 MIME → 415；非 PDF 字节冒充 PDF → 415', async () => {
    expect((await extract({ mode: 'image' }, { imageBase64: 'AAAA', imageMime: 'image/gif' })).statusCode).toBe(415);
    expect((await extract({ mode: 'pdf' }, { pdfBase64: 'AAAA' })).statusCode).toBe(415);
    expect(up.state.credits).toBe(100);
  });

  it('GEMINI_API_KEY 未配置 → 501 且零扣费（扣费必须在确认能执行之后）', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await extract({ mode: 'text', text: 'Pin 1 VCC, Pin 2 GND, Pin 3 OUT, SOIC-8 package' });
    expect(res.statusCode).toBe(501);
    expect(up.state.credits).toBe(100);
    expect(up.calls.consume).toBe(0);
  });

  it('mode=url：服务端真的抓取页面，正文进入模型而不是只给 URL', async () => {
    const seenPrompts = [];
    vi.stubGlobal('fetch', async (url, init) => {
      const u = String(url);
      if (u === 'https://vendor.example/ch340c.html') {
        return new Response('<html><body><h1>CH340C</h1><p>USB to serial. Pin 1 GND Pin 2 TXD Pin 3 RXD Pin 16 VCC. SOP-16 package 10x4mm</p><script>junk()</script></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (u.includes('generativelanguage')) { seenPrompts.push(JSON.parse(init.body).contents[0].parts.map((p) => p.text ?? '').join('')); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] })); }
      if (u.endsWith('/me')) return new Response(JSON.stringify({ data: { userId: 'u1', credits: 100 } }));
      if (u.endsWith('/credits/consume')) return new Response(JSON.stringify({ remaining: 96 }));
      return new Response('{}');
    });
    const res = await extract({ mode: 'url', url: 'https://vendor.example/ch340c.html' });
    if (res.statusCode !== 200) console.log('URL-BODY', res.body);
    expect(res.statusCode).toBe(200);
    expect(seenPrompts.length).toBe(1);
    expect(seenPrompts[0]).toContain('Pin 16 VCC');          // 页面正文到达了模型
    expect(seenPrompts[0]).not.toContain('junk()');          // 脚本被剥掉
  });
});

describe('/api/ds2kicad 外部匿名调用（P0-2）', () => {
  it('匿名 POST → 401，零上游调用', async () => {
    process.env.EZPLM_AUTH_BASE = 'https://auth.test/api/v1'; process.env.AI_REQUIRE_AUTH = '1';
    process.env.DS2KICAD_URL = 'https://ds2kicad.test';
    const up = installUpstreamMock();
    const { default: ds2 } = await import('../ds2kicad.js');
    const res = mockRes();
    await ds2(req({ body: { pdfBase64: 'JVBERi0x' } }), res);
    expect(res.statusCode).toBe(401);
    const upstream = Object.entries(up.calls).filter(([k]) => !['me', 'consume'].includes(k)).reduce((a, [, v]) => a + v, 0);
    expect(upstream).toBe(0);
    delete process.env.DS2KICAD_URL; delete process.env.EZPLM_AUTH_BASE; vi.unstubAllGlobals();
  });
});

describe('application-projects 代理已下线（P0-9）', () => {
  it('GET /api/ezplm?path=application-projects → 501 APPLICATION_PROJECTS_NOT_CONNECTED，不打上游', async () => {
    process.env.EZPLM_API_KEY = 'global-key';
    const up = installUpstreamMock();
    const { default: ezplm } = await import('../ezplm.js');
    const res = mockRes();
    await ezplm(req({ method: 'GET', query: { path: 'application-projects', partlibId: 'p1', mpn: 'X' } }), res);
    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).code).toBe('APPLICATION_PROJECTS_NOT_CONNECTED');
    expect(Object.values(up.calls).reduce((a, v) => a + v, 0)).toBe(0);
    delete process.env.EZPLM_API_KEY; vi.unstubAllGlobals();
  });
});

describe('分销商检索：匿名放行 + 限频（不耗 AI Token）', () => {
  beforeEach(() => {
    process.env.EZPLM_AUTH_BASE = 'https://auth.test/api/v1';
    process.env.DIGIKEY_CLIENT_ID = 'id'; process.env.DIGIKEY_CLIENT_SECRET = 'sec';
    process.env.ANON_SEARCH_PER_HOUR = '3';
  });
  afterEach(() => { for (const k of ['EZPLM_AUTH_BASE', 'DIGIKEY_CLIENT_ID', 'DIGIKEY_CLIENT_SECRET', 'ANON_SEARCH_PER_HOUR']) delete process.env[k]; vi.unstubAllGlobals(); });

  it('匿名前几次放行（不再 401），超额后 429 且不打上游', async () => {
    const up = installUpstreamMock();
    const ip = '198.51.100.7';
    let last;
    for (let i = 0; i < 3; i++) {
      last = mockRes();
      await digikeyHandler(req({ method: 'GET', query: { path: 'fuzzy', q: 'CH340C' }, socket: { remoteAddress: ip } }), last);
      expect(last.statusCode).not.toBe(401);
    }
    const upstreamBefore = up.calls.digikey;
    const res = mockRes();
    await digikeyHandler(req({ method: 'GET', query: { path: 'fuzzy', q: 'CH340C' }, socket: { remoteAddress: ip } }), res);
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).code).toBe('ANON_RATE_LIMITED');
    expect(up.calls.digikey).toBe(upstreamBefore);   // 超额那次零上游调用
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { acquire, checkBodySize, checkAiPayload, callerKey, __resetGuard, LIMITS } from '../_lib/guard.js';

const req = (over = {}) => ({ headers: {}, socket: { remoteAddress: '9.9.9.9' }, ...over });

describe('服务端配额防护', () => {
  beforeEach(() => __resetGuard());

  it('超过每分钟上限后返回 429 并带 Retry-After', () => {
    // 真实调用是「取→用→放」，逐次释放才测得到频率上限（不释放会先撞并发上限）
    for (let i = 0; i < LIMITS.perWindow; i++) {
      const r = acquire(req(), 'test');
      expect(r.ok).toBe(true);
      r.release();
    }
    const over = acquire(req(), 'test');
    expect(over.ok).toBe(false);
    expect(over.status).toBe(429);
    expect(over.retryAfter).toBeGreaterThan(0);
  });

  it('并发上限独立生效（不释放即占用）', () => {
    __resetGuard();
    const held = [];
    for (let i = 0; i < LIMITS.concurrent; i++) held.push(acquire(req(), 'c'));
    expect(held.every((h) => h.ok)).toBe(true);
    const blocked = acquire(req(), 'c');
    expect(blocked.ok).toBe(false);
    held[0].release();
    expect(acquire(req(), 'c').ok).toBe(true);
  });

  it('不同调用方与不同 scope 各自计数', () => {
    __resetGuard();
    const a = req({ socket: { remoteAddress: '1.1.1.1' } });
    const b = req({ socket: { remoteAddress: '2.2.2.2' } });
    for (let i = 0; i < LIMITS.perWindow; i++) acquire(a, 's').release();
    expect(acquire(a, 's').ok).toBe(false);
    expect(acquire(b, 's').ok).toBe(true);       // 另一个 IP 不受影响
    expect(acquire(a, 'other').ok).toBe(true);   // 另一个 scope 不受影响
  });

  it('客户端 session 头不能替代 IP 成为配额主体（防轮换绕过）', () => {
    const withSess = callerKey(req({ headers: { 'x-cc-session': 'abc' } }));
    expect(withSess.startsWith('ip:')).toBe(true);
    // x-forwarded-for 取链尾（反代追加的可信一跳），客户端伪造的前缀无效
    expect(callerKey(req({ headers: { 'x-forwarded-for': '5.5.5.5, 6.6.6.6' } }))).toBe('ip:6.6.6.6');
  });

  it('请求体超限返回 413', () => {
    expect(checkBodySize(req({ headers: { 'content-length': String(99 * 1024 * 1024) } })).ok).toBe(false);
    expect(checkBodySize(req({ headers: { 'content-length': '100' } })).ok).toBe(true);
  });

  it('AI 入参：prompt 长度 / 附件大小 / MIME 白名单', () => {
    expect(checkAiPayload({ prompt: 'x'.repeat(LIMITS.promptChars + 1) }).status).toBe(413);
    expect(checkAiPayload({ prompt: 'ok', pdfBase64: 'A'.repeat(LIMITS.fileBytes * 2) }).status).toBe(413);
    expect(checkAiPayload({ prompt: 'ok', imageBase64: 'AAAA', imageMime: 'image/gif' }).status).toBe(415);
    expect(checkAiPayload({ prompt: 'ok', imageBase64: 'AAAA', imageMime: 'image/png' }).ok).toBe(true);
  });
});

describe('请求体解析（Buffer 曾导致「一上传就 400」）', () => {
  it('对象 / 字符串 / Buffer / Uint8Array 都能读到字段', async () => {
    const { readJsonBody } = await import('../_lib/guard.js');
    const payload = { prompt: 'extract', pdfBase64: 'JVBERi0xLjQK' };
    const text = JSON.stringify(payload);
    expect(readJsonBody({ body: payload })).toEqual(payload);
    expect(readJsonBody({ body: text })).toEqual(payload);
    expect(readJsonBody({ body: Buffer.from(text) })).toEqual(payload);
    expect(readJsonBody({ body: new Uint8Array(Buffer.from(text)) })).toEqual(payload);
  });

  it('空 / 损坏的 body 安全回落为空对象，不抛异常', async () => {
    const { readJsonBody } = await import('../_lib/guard.js');
    expect(readJsonBody({})).toEqual({});
    expect(readJsonBody({ body: null })).toEqual({});
    expect(readJsonBody({ body: '' })).toEqual({});
    expect(readJsonBody({ body: Buffer.from('not json') })).toEqual({});
  });

  it('旧字段 fileBase64 也计入附件大小上限', async () => {
    const { checkAiPayload, LIMITS } = await import('../_lib/guard.js');
    expect(checkAiPayload({ prompt: 'x', fileBase64: 'A'.repeat(LIMITS.fileBytes * 2) }).status).toBe(413);
  });
});

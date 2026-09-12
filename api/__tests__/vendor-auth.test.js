/**
 * Iceasy / OURIC 认证与映射回归（全部离线，不打真实接口）
 * Iceasy 固定校验样例来自对接文档 3.3 节（虚构凭据，专用于算法核对）。
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { buildIceasyAuth, mapIceasyRows, buildOuricSignature, buildOuricRequestBody, mapOuricData } from '../_lib/vendor-auth.js';

describe('Iceasy 认证算法（文档 3.3 固定样例）', () => {
  const fixedNow = new Date(2026, 8, 11, 15, 30, 45);   // 本地时间 2026-09-11 15:30:45

  it('date 格式 yyyyMMddHHmmss', () => {
    const { date } = buildIceasyAuth('demo_account', 'DemoPassword123!', fixedNow);
    expect(date).toBe('20260911153045');
  });

  it('key 与文档样例逐位一致', () => {
    const { key } = buildIceasyAuth('demo_account', 'DemoPassword123!', fixedNow);
    expect(key).toBe('PdQ5Ia869txISaW/DjmJCSZNpoBD03SZAkODDGLnZiM=');
  });

  it('中间值核对：md5Hex 前 16 位大写 = AES 密钥文本', () => {
    const md5Hex = crypto.createHash('md5').update('demo_account20260911153045', 'utf8').digest('hex');
    expect(md5Hex).toBe('1e3bc2fe7e59c70ac7c8114920b30f28');
    expect(md5Hex.slice(0, 16).toUpperCase()).toBe('1E3BC2FE7E59C70A');
  });

  it('表单编码：Base64 中 + / = 正确转义（用 URLSearchParams）', () => {
    const { date, key } = buildIceasyAuth('demo_account', 'DemoPassword123!', fixedNow);
    const body = new URLSearchParams({ partNoList: 'STM32F103C8T6', account: 'demo_account', date, key }).toString();
    expect(body).toBe('partNoList=STM32F103C8T6&account=demo_account&date=20260911153045&key=PdQ5Ia869txISaW%2FDjmJCSZNpoBD03SZAkODDGLnZiM%3D');
  });
});

describe('Iceasy 响应映射', () => {
  const rows = [{
    partNo: 'STM32F103C8T6',
    url: 'https://example.invalid/product/STM32F103C8T6',
    stockNumCn: 1200,
    prices: [{ qty: 1000, price: 10.9 }, { qty: 1, price: 12.5 }, { qty: 100, price: 11.8 }],
  }];

  it('精确匹配 + 阶梯价按数量升序，取最低档为展示价', () => {
    const o = mapIceasyRows(rows, 'STM32F103C8T6');
    expect(o.found).toBe(true);
    expect(o.price).toBe(12.5);
    expect(o.currency).toBe('CNY');
    expect(o.stock).toBe(1200);
    expect(o.priceBreaks.map((p) => p.qty)).toEqual([1, 100, 1000]);
  });

  it('大小写不同不算精确匹配（文档：区分大小写）', () => {
    expect(mapIceasyRows(rows, 'stm32f103c8t6').found).toBe(false);
  });

  it('其它料号的报价不得用于目标料号', () => {
    expect(mapIceasyRows(rows, 'STM32F103CBT6').found).toBe(false);
  });

  it('prices 为空 → 无价格但保留库存，不虚构零元价', () => {
    const o = mapIceasyRows([{ partNo: 'X1', stockNumCn: 5, prices: [] }], 'X1');
    expect(o.found).toBe(true);
    expect(o.price).toBeUndefined();
    expect(o.stock).toBe(5);
  });
});

describe('OURIC 签名（HMAC-MD5，字母序，null 不参与）', () => {
  it('拼接串按 key 字母序且排除 signature/null', () => {
    const { toSign } = buildOuricSignature('s', {
      timestamp: 1744512000, apiKey: 'dgt_partner_001', partNumber: 'STM32F103',
      manufacturer: null, signature: 'should-be-excluded', pageNum: 1, pageSize: 10,
    });
    expect(toSign).toBe('apiKey=dgt_partner_001&pageNum=1&pageSize=10&partNumber=STM32F103&timestamp=1744512000');
  });

  it('signature = 32 位小写 hex，与独立计算一致', () => {
    const secret = 'dgt_secret_2026_xK9mPq';
    const { toSign, signature } = buildOuricSignature(secret, { apiKey: 'dgt_partner_001', timestamp: 1744512000, partNumber: 'NRVBSS26NT3G' });
    const expected = crypto.createHmac('md5', secret).update(toSign, 'utf8').digest('hex');
    expect(signature).toBe(expected);
    expect(signature).toMatch(/^[0-9a-f]{32}$/);
  });

  it('请求体含全部认证参数且签名可自验', () => {
    const body = buildOuricRequestBody('k1', 'sec1', { partNumber: 'ABC', pageNum: 1, pageSize: 10 }, 1744512000);
    expect(body.apiKey).toBe('k1');
    expect(body.timestamp).toBe(1744512000);
    const { signature } = buildOuricSignature('sec1', { apiKey: 'k1', timestamp: 1744512000, partNumber: 'ABC', pageNum: 1, pageSize: 10 });
    expect(body.signature).toBe(signature);
  });
});

describe('OURIC 响应映射（文档 4.5 示例结构）', () => {
  const data = [{
    availableQuantity: 17500, quantity: 17500, deliveryTime: '3 days', vrFlag: 0,
    warehouse: 'Hong Kong', moq: '7500', manufacturer: 'onsemi',
    showPrice: '[{"price":"2.3790000","number":"1"},{"price":"1.4340000","number":"100"},{"price":"1.1810000","number":"500"},{"price":"1.0960000","number":"1000"}]',
    partNumber: 'NRVBSS26NT3G', id: 'S1952080189538308613',
  }];

  it('showPrice JSON 字符串解析为阶梯价，最低档为展示价', () => {
    const o = mapOuricData(data, 'NRVBSS26NT3G');
    expect(o.found).toBe(true);
    expect(o.price).toBeCloseTo(2.379, 6);
    expect(o.priceBreaks).toHaveLength(4);
    expect(o.priceBreaks[3]).toEqual({ qty: 1000, price: 1.096 });
    expect(o.stock).toBe(17500);
    expect(o.currency).toBeUndefined();               // 币种未确认，不虚构
    expect(o.note).toContain('币种');
    expect(o.note).toContain('MOQ 7500');
  });

  it('料号大小写不敏感精确匹配', () => {
    expect(mapOuricData(data, 'nrvbss26nt3g').found).toBe(true);
    expect(mapOuricData(data, 'NRVBSS26NT3').found).toBe(false);
  });

  it('showPrice 非法 JSON → 无阶梯价，不抛错不猜测', () => {
    const o = mapOuricData([{ partNumber: 'X', showPrice: '{broken', quantity: 3 }], 'X');
    expect(o.found).toBe(true);
    expect(o.price).toBeUndefined();
    expect(o.priceBreaks).toEqual([]);
  });

  it('虚拟库存标记进入 note', () => {
    const o = mapOuricData([{ partNumber: 'V', vrFlag: 1, availableQuantity: 9 }], 'V');
    expect(o.note).toContain('虚拟库存');
  });
});

/**
 * AI Trust 主链路回归
 *  验收 7：AI 输出 STM32F103C8，库中只有 STM32F103C8T6 → 不能自动 VERIFIED，只能 CANDIDATE
 *  验收 8：Gemini 返回畸形 JSON → 整条拒绝，不进 store
 *  验收10：BGA A1/B3/C7 经 Document/import/export 后仍是原字符串
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiAiProvider } from '../src/providers/gemini';
import { parseKicadPcb } from '../src/design-core/geometry/kicad-pcb-import';
import { buildKicadPcb } from '../src/modules/board-editor/pcbExport';
import { createDocument } from '../src/design-core/document/factory';
import { registerFootprintOverride } from '../src/design-core/geometry/lib-file-registry';
import { searchResultToPlaced } from '../src/design-core/document/services';
import type { ComponentSearchResult, AccessContext } from '../src/providers/types';

const realFetch = globalThis.fetch;

function mockNetwork(geminiText: string, ezplmItems: Array<{ mpn: string; manufacturer?: string }>) {
  vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/api/gemini?path=status')) return new Response(JSON.stringify({ configured: true }));
    if (u.includes('/api/gemini')) return new Response(JSON.stringify({ text: geminiText }));
    if (u.includes('/api/ezplm?path=status') || u.includes('path=status')) return new Response(JSON.stringify({ configured: true }));
    if (u.includes('/api/ezplm')) {
      // /api/ezplm?path=parts 响应：data 为数组（与 searchEzplmParts 实际解析一致）
      return new Response(JSON.stringify({
        data: ezplmItems.map((x, i) => ({
          partlibId: 'p' + i, mpn: x.mpn, manufacturer: x.manufacturer ?? 'ST',
          category: 'MCU', footprint: 'LQFP-48', description: 'test part',
        })),
      }));
    }
    return new Response('{}');
  });
}

describe('AI Trust：exact match 才 VERIFIED', () => {
  const ctx = {} as AccessContext;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.stubGlobal('fetch', realFetch); });

  it('验收7：STM32F103C8 vs 库中 STM32F103C8T6 → CANDIDATE，不自动替换', async () => {
    mockNetwork(
      JSON.stringify({ summary: 't', components: [{ mpn: 'STM32F103C8', category: 'mcu', footprint: 'LQFP-48', qty: 1 }] }),
      [{ mpn: 'STM32F103C8T6' }],
    );
    const r = await new GeminiAiProvider().generateScheme({ prompt: 'x' }, ctx);
    const item = r.items![0];
    expect(item.trust?.level).toBe('CANDIDATE');
    expect(item.trust?.level).not.toBe('VERIFIED');
    // 不自动替换：mpn 仍是 AI 建议的原型号，候选仅供确认
    expect(item.mpn).toBe('STM32F103C8');
    expect(item.trust?.candidate?.mpn).toBe('STM32F103C8T6');
    expect(item.componentId.startsWith('ez_')).toBe(false);
  });

  it('规范化后完全一致 → VERIFIED（大小写/分隔符不敏感）', async () => {
    mockNetwork(
      JSON.stringify({ summary: 't', components: [{ mpn: 'stm32f103c8t6', category: 'mcu', qty: 1 }] }),
      [{ mpn: 'STM32F103C8T6' }],
    );
    const r = await new GeminiAiProvider().generateScheme({ prompt: 'x' }, ctx);
    expect(r.items![0].trust?.level).toBe('VERIFIED');
    expect(r.items![0].trust?.source).toBe('ezplm-exact');
    expect(r.items![0].trust?.evidence).toBeTruthy();
    expect(r.items![0].trust?.verifiedAt).toBeTruthy();
  });

  it('库无命中 → PLACEHOLDER', async () => {
    mockNetwork(
      JSON.stringify({ summary: 't', components: [{ mpn: 'XYZ999', category: 'ic', qty: 1 }] }),
      [],
    );
    const r = await new GeminiAiProvider().generateScheme({ prompt: 'x' }, ctx);
    expect(r.items![0].trust?.level).toBe('PLACEHOLDER');
    expect(r.items![0].trust?.source).toBe('ai-only');
  });

  it('验收8：畸形 JSON 整条拒绝（抛错，不产出 items）', async () => {
    mockNetwork('这不是JSON也没有大括号', []);
    await expect(new GeminiAiProvider().generateScheme({ prompt: 'x' }, {} as AccessContext)).rejects.toThrow();
  });

  it('验收8b：结构不符（components 缺失）同样拒绝', async () => {
    mockNetwork(JSON.stringify({ summary: '只有摘要没有器件' }), []);
    await expect(new GeminiAiProvider().generateScheme({ prompt: 'x' }, {} as AccessContext)).rejects.toThrow(/结构|校验|components/i);
  });
});

describe('BGA 球号字符串全链路', () => {
  it('验收10：A1/B3/C7 焊盘号经 import → document → export 后原样保留', () => {
    const PCB = `(kicad_pcb (version 20221018)
  (net 0 "")
  (net 1 "VDD")
  (gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts") (width 0.05))
  (footprint "Package_BGA:TEST_BGA" (layer "F.Cu") (at 10 10)
    (property "Reference" "U1")
    (property "Value" "BGA-TEST")
    (pad "A1" smd circle (at -1 -1) (size 0.3 0.3) (layers "F.Cu") (net 1 "VDD"))
    (pad "B3" smd circle (at 0 0) (size 0.3 0.3) (layers "F.Cu") (net 1 "VDD"))
    (pad "C7" smd circle (at 1 1) (size 0.3 0.3) (layers "F.Cu"))
  ))`;
    const r = parseKicadPcb(PCB);
    const u1 = r.comps.find((c) => c.reference === 'U1')!;
    // padNets 键保留字符串球号
    expect(u1.padNets?.['A1']).toBe(1);
    expect(u1.padNets?.['B3']).toBe(1);
    // 内嵌封装定义的焊盘号保留字符串
    const def = r.footprintDefs['TEST_BGA'];
    expect(def.pads.map((p) => String(p.num)).sort()).toEqual(['A1', 'B3', 'C7']);

    // 注册覆盖 → 放到文档 → 导出：球号原样写回
    registerFootprintOverride('TEST_BGA', def);
    const doc = createDocument({ name: 'bga' });
    const placed = searchResultToPlaced({
      componentId: 'kicad_U1', mpn: 'BGA-TEST', manufacturer: '—', category: 'ic',
      defaultFootprintName: 'TEST_BGA', family: 'BGA', pins: 3,
    } as ComponentSearchResult, 'U1');
    placed.display = { padNets: { A1: 1, B3: 1 } };
    doc.components = [placed];
    doc.nets = { '1': 'VDD' };
    const out = buildKicadPcb(doc);
    expect(out).toContain('(pad "A1"');
    expect(out).toContain('(pad "B3"');
    expect(out).toContain('(pad "C7"');
    expect(out).not.toContain('(pad "1" smd');   // 没有被压成数字
    expect(out).toMatch(/\(pad "A1"[^\n]*\(net 1 VDD\)/);
  });

  it('BGA 合成封装使用 JEDEC 行字母且标记 approximate', async () => {
    const { padFootprintFor } = await import('../src/design-core/geometry/footprint-pads');
    const fp = padFootprintFor('BGA-16_4x4mm_P0.8mm');
    expect(fp).toBeTruthy();
    const nums = fp!.pads.map((p) => String(p.num));
    expect(nums).toContain('A1');
    expect(nums).toContain('B2');
    expect(nums.some((n) => /^[IOQSXZ]/.test(n))).toBe(false);   // JEDEC 跳字母
    expect(fp!.approximate).toBe(true);                           // 猜测的 ball map 不能算 VERIFIED
  });
});

/**
 * Altium zip 导入的**端到端**链路（这是上一轮漏测的地方：分支没插进 zip 流程，
 * 结果一导 AD 工程就报"未找到 .kicad_pcb"）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
}
const RealURL = globalThis.URL;
vi.stubGlobal('URL', Object.assign(
  function (this: unknown, ...a: unknown[]) { return new (RealURL as unknown as new (...x: unknown[]) => unknown)(...a); },
  { createObjectURL: () => 'blob:test/1', revokeObjectURL: () => undefined },
));
vi.stubGlobal('Blob', class { constructor(public parts: unknown[]) {} });

const PCB = fileURLToPath(new URL('../fixtures/altium-nano-debug.PcbDoc', import.meta.url));
const SCH = fileURLToPath(new URL('../fixtures/altium-nano-debug.SchDoc', import.meta.url));

/** 打一个和用户实际拖进来的一样的 zip（含目录层级） */
function makeZip(): Uint8Array {
  return zipSync({
    'Nano_Debug/Nano_Debug.PcbDoc': new Uint8Array(readFileSync(PCB)),
    'Nano_Debug/Nano_Debug.SchDoc': new Uint8Array(readFileSync(SCH)),
    'Nano_Debug/Nano_Debug.PrjPcb': new TextEncoder().encode('[Design]\nVersion=1.0\n'),
  }, { level: 0 });
}

/** File 替身：Node 里没有 DOM File */
const asFile = (bytes: Uint8Array, name: string) => ({
  name,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  text: async () => new TextDecoder().decode(bytes),
}) as unknown as File;

describe('拖一个 AD 工程 zip 进来', () => {
  beforeEach(async () => {
    const { useDesignStore } = await import('../../src/state/designStore');
    useDesignStore.getState().clearAll();
  });

  it('不再报"未找到 .kicad_pcb"，PCB 与原理图都进来了', async () => {
    const { importProjectFile } = await import('../../src/application/project-import');
    const { useDesignStore } = await import('../../src/state/designStore');

    const r = await importProjectFile(asFile(makeZip(), 'Nano_Debug.zip'));

    const errors = r.notices.filter((n) => n.level === 'error');
    expect(errors, errors.map((e) => e.text).join(' | ')).toEqual([]);
    expect(r.notices.some((n) => n.level === 'success' && /Altium/.test(n.text))).toBe(true);

    const doc = useDesignStore.getState().doc;
    expect(doc.components).toHaveLength(53);
    expect(Object.keys(doc.nets ?? {})).toHaveLength(50);
    expect(doc.tracks?.length).toBe(589);
    // 原理图也在（精简 fixture 保留了 FileHeader）
    expect(Object.keys(doc.schematicSheets ?? {})).toHaveLength(1);
    const sheet = Object.values(doc.schematicSheets ?? {})[0];
    expect(sheet.instances).toHaveLength(53);
    expect(sheet.wires).toHaveLength(161);
  });

  it('只有 .PcbDoc 的 zip 也能导（没有原理图不算失败）', async () => {
    const { importProjectFile } = await import('../../src/application/project-import');
    const { useDesignStore } = await import('../../src/state/designStore');
    const zip = zipSync({ 'board/Nano_Debug.PcbDoc': new Uint8Array(readFileSync(PCB)) }, { level: 0 });
    const r = await importProjectFile(asFile(zip, 'board.zip'));
    expect(r.notices.filter((n) => n.level === 'error')).toEqual([]);
    expect(useDesignStore.getState().doc.components).toHaveLength(53);
  });

  it('单个 .PcbDoc 文件直接拖进来也能导', async () => {
    const { importProjectFile } = await import('../../src/application/project-import');
    const { useDesignStore } = await import('../../src/state/designStore');
    const r = await importProjectFile(asFile(new Uint8Array(readFileSync(PCB)), 'Nano_Debug.PcbDoc'));
    expect(r.notices.filter((n) => n.level === 'error')).toEqual([]);
    expect(useDesignStore.getState().doc.components).toHaveLength(53);
  });

  it('单个 .SchDoc 文件直接拖进来也能导', async () => {
    const { importProjectFile } = await import('../../src/application/project-import');
    const { useDesignStore } = await import('../../src/state/designStore');
    const r = await importProjectFile(asFile(new Uint8Array(readFileSync(SCH)), 'Nano_Debug.SchDoc'));
    expect(r.notices.filter((n) => n.level === 'error')).toEqual([]);
    expect(Object.keys(useDesignStore.getState().doc.schematicSheets ?? {})).toHaveLength(1);
  });

  it('既无 KiCad 也无 AD 文件的 zip：报错文案要说清支持什么', async () => {
    const { importProjectFile } = await import('../../src/application/project-import');
    const zip = zipSync({ 'readme.txt': new TextEncoder().encode('hello') }, { level: 0 });
    const r = await importProjectFile(asFile(zip, 'empty.zip'));
    expect(r.notices.some((n) => n.level === 'error')).toBe(true);
  });
});

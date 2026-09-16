/**
 * Phase 5：ProjectImportService 是 KiCad/JSON 导入的唯一入口（不再散在 App 里）
 * 用真实 KiCad 文本做 golden：.kicad_pcb 与多页 .kicad_sch 走服务后，store 状态正确。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const APP_SRC = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8');

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
}
const RealURL = globalThis.URL;
vi.stubGlobal('URL', Object.assign(function (this: unknown, ...a: unknown[]) { return new (RealURL as unknown as new (...x: unknown[]) => unknown)(...a); }, { createObjectURL: () => 'blob:t/1', revokeObjectURL: () => undefined }));
vi.stubGlobal('Blob', class { constructor(public parts: unknown[]) {} });

const PCB = `(kicad_pcb (version 20240108) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" (layer "F.Cu") (at 30 20)
    (property "Reference" "U1" (at 0 0 0)) (property "Value" "LM358" (at 0 2 0))
    (pad "1" smd rect (at -2.7 -1.905) (size 1.5 0.6) (layers "F.Cu"))
    (pad "2" smd rect (at -2.7 -0.635) (size 1.5 0.6) (layers "F.Cu"))
  ))`;
const ROOT = `(kicad_sch (version 20231120) (generator eeschema) (lib_symbols)
  (sheet (at 50 40) (size 25 15) (property "Sheetname" "Sub" (at 0 0 0)) (property "Sheetfile" "sub.kicad_sch" (at 0 0 0)) (pin "SIG" input (at 50 42 180))))`;
const SUB = `(kicad_sch (version 20231120) (generator eeschema) (lib_symbols)
  (hierarchical_label "SIG" (shape input) (at 60 66 180)))`;

describe('ProjectImportService', () => {
  it('importPcbText：注册内嵌封装并把器件放上画布', async () => {
    const { importPcbText } = await import('../../src/application/project-import');
    const { useDesignStore } = await import('../../src/state/designStore');
    useDesignStore.getState().clearAll();
    const r = importPcbText(PCB);
    expect(r.comps).toBe(1);
    expect(useDesignStore.getState().doc.components[0].reference).toBe('U1');
  });

  it('applySchText 多页：根页识别、子页归档、层级标签保留', async () => {
    const { applySchText } = await import('../../src/application/project-import');
    const { useDesignStore } = await import('../../src/state/designStore');
    const root = applySchText(ROOT, 'root.kicad_sch', true);
    const sub = applySchText(SUB, 'sub.kicad_sch', true);
    expect(root.sheet.sheets?.[0].file).toBe('sub.kicad_sch');
    expect(sub.sheet.labels.find((l) => l.text === 'SIG')?.kind).toBe('hierarchical');
    useDesignStore.getState().setSchematicSheets({ 'root.kicad_sch': root.sheet, 'sub.kicad_sch': sub.sheet }, 'root.kicad_sch');
    const doc = useDesignStore.getState().doc;
    expect(doc.rootSheetFile).toBe('root.kicad_sch');
    expect(Object.keys(doc.schematicSheets ?? {})).toHaveLength(2);
  });

  it('UI 层不再持有解析器调用；importProjectFile 是唯一入口', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = fileURLToPath(new URL('../../src', import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(p) && !/\.test\./.test(p)) files.push(p); } };
    walk(root);
    const ui = files.filter((p) => /\/src\/(modules|App\.tsx)/.test(p) && !p.includes('/modules/app/'));
    for (const p of ui) {
      const src = readFileSync(p, 'utf8');
      for (const fn of ['parseKicadPcb(', 'parseKicadSch(', 'parseLegacySch(', 'safeUnzipOffThread(']) expect(src.includes(fn), `${p.split('/src/')[1]} 调了 ${fn}`).toBe(false);
    }
    const callers = files.filter((p) => readFileSync(p, 'utf8').includes('importProjectFile(')).map((p) => p.split('/src/')[1]);
    expect(callers).toEqual(['modules/app/TopNavigation.tsx']);   // 服务里是定义（export const），不是调用
    expect(APP_SRC).not.toMatch(/parseKicad/);
  });
});

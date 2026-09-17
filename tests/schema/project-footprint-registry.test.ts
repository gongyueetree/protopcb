/**
 * PROJECT 层几何与 doc.importedFootprints 必须始终一致：
 * 导入替换（不合并）、清空清掉、undo/redo 跟着回滚。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { parseKicadPcb } from '../../src/design-core/geometry/kicad-pcb-import';
import { useDesignStore } from '../../src/state/designStore';
import { footprintOverrideFor, clearFootprintOverrides } from '../../src/design-core/geometry/lib-file-registry';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
}

/** 造一块板：封装名固定，焊盘 y 间距可变 —— 用它区分"来自哪个工程" */
const board = (fp: string, ref: string, dy: number) => `(kicad_pcb (version 20240108) (generator pcbnew)
  (general (thickness 1.6)) (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user)) (net 0 "")
  (footprint "Lib:${fp}" (layer "F.Cu") (at 20 20)
    (property "Reference" "${ref}" (at 0 0 0)) (property "Value" "V" (at 0 2 0))
    (pad "1" smd rect (at -2 ${-dy}) (size 1 0.4) (layers "F.Cu"))
    (pad "2" smd rect (at -2 ${dy}) (size 1 0.4) (layers "F.Cu"))))`;

const A = () => parseKicadPcb(board('SOIC-8', 'U1', 0.65));
const B = () => parseKicadPcb(board('SOIC-8', 'U9', 1.27));
const spacing = () => {
  const ys = footprintOverrideFor('SOIC-8')?.pads.map((p) => p.y) ?? [];
  return ys.length === 2 ? Math.abs(ys[1] - ys[0]) : NaN;
};

describe('PROJECT 层与文档同步', () => {
  beforeEach(() => { useDesignStore.getState().clearAll(); clearFootprintOverrides(); });

  it('导入 B 后只剩 B 的定义（替换，不与 A 合并）', () => {
    useDesignStore.getState().importKicad(A());
    expect(spacing()).toBeCloseTo(1.3, 1);
    useDesignStore.getState().importKicad(B());
    expect(spacing()).toBeCloseTo(2.54, 1);
    const defs = useDesignStore.getState().doc.importedFootprints!;
    expect(Object.keys(defs)).toEqual(['SOIC-8']);
  });

  it('clearAll 清掉工程几何（新工程不会沿用旧焊盘）', () => {
    useDesignStore.getState().importKicad(A());
    expect(footprintOverrideFor('SOIC-8')).toBeDefined();
    useDesignStore.getState().clearAll();
    expect(useDesignStore.getState().doc.importedFootprints).toBeUndefined();
    expect(footprintOverrideFor('SOIC-8')).toBeUndefined();
  });

  it('undo/redo：几何跟着文档一起回滚', () => {
    const ds = useDesignStore.getState();
    ds.importKicad(A());
    ds.importKicad(B());
    expect(spacing()).toBeCloseTo(2.54, 1);
    ds.undo();
    expect(spacing()).toBeCloseTo(1.3, 1);     // 回到 A
    ds.redo();
    expect(spacing()).toBeCloseTo(2.54, 1);    // 回到 B
  });

  it('undo 快照不含新工程的定义（snapshot 必须先于改动）', () => {
    const ds = useDesignStore.getState();
    ds.clearAll();
    ds.importKicad(A());
    ds.undo();                                  // 撤销"导入 A"
    expect(useDesignStore.getState().doc.importedFootprints).toBeUndefined();
    expect(footprintOverrideFor('SOIC-8')).toBeUndefined();
  });
});

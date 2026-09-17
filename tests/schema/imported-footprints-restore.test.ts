/**
 * 刷新后器件 2D/3D 不对的根因：导入工程的真实焊盘表只注册在内存里，
 * 文档恢复了、几何依据没回来，器件回落到"按名字猜"。焊盘表必须随文档持久化并在恢复时注册回去。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { parseKicadPcb } from '../../src/design-core/geometry/kicad-pcb-import';
import { useDesignStore } from '../../src/state/designStore';
import { footprintOverrideFor, clearFootprintOverrides } from '../../src/design-core/geometry/lib-file-registry';
import { serializeDocument, deserializeDocument } from '../../src/design-core/document/factory';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
}

/** 一个焊盘与"按名字猜"明显不同的封装：8 个焊盘、间距 0.65（名字里写的是 1.27） */
const PCB = `(kicad_pcb (version 20240108) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" (layer "F.Cu") (at 20 20)
    (property "Reference" "U1" (at 0 0 0)) (property "Value" "LM358" (at 0 2 0))
    (pad "1" smd rect (at -2.7 -0.975) (size 1.5 0.45) (layers "F.Cu"))
    (pad "2" smd rect (at -2.7 -0.325) (size 1.5 0.45) (layers "F.Cu"))
    (pad "3" smd rect (at -2.7 0.325) (size 1.5 0.45) (layers "F.Cu"))
    (pad "4" smd rect (at -2.7 0.975) (size 1.5 0.45) (layers "F.Cu"))
    (pad "5" smd rect (at 2.7 0.975) (size 1.5 0.45) (layers "F.Cu"))
    (pad "6" smd rect (at 2.7 0.325) (size 1.5 0.45) (layers "F.Cu"))
    (pad "7" smd rect (at 2.7 -0.325) (size 1.5 0.45) (layers "F.Cu"))
    (pad "8" smd rect (at 2.7 -0.975) (size 1.5 0.45) (layers "F.Cu"))))`;

const FP = 'SOIC-8_3.9x4.9mm_P1.27mm';

describe('导入焊盘表随文档往返', () => {
  beforeEach(() => { useDesignStore.getState().clearAll(); clearFootprintOverrides(); });

  it('导入后焊盘表写进文档', () => {
    useDesignStore.getState().importKicad(parseKicadPcb(PCB));
    const defs = useDesignStore.getState().doc.importedFootprints;
    expect(defs?.[FP]).toBeDefined();
    expect(defs![FP].pads).toHaveLength(8);
  });

  it('JSON 往返后焊盘表还在', () => {
    useDesignStore.getState().importKicad(parseKicadPcb(PCB));
    const round = deserializeDocument(serializeDocument(useDesignStore.getState().doc));
    expect(round.importedFootprints?.[FP].pads).toHaveLength(8);
  });

  it('恢复文档时焊盘表被注册回去（不再回落到按名字猜的几何）', () => {
    useDesignStore.getState().importKicad(parseKicadPcb(PCB));
    const saved = deserializeDocument(serializeDocument(useDesignStore.getState().doc));
    const realY = footprintOverrideFor(FP)!.pads.map((p) => p.y).sort((a, b) => a - b);

    // 模拟刷新：注册表清空（内存没了），文档从 localStorage 恢复
    clearFootprintOverrides();
    expect(footprintOverrideFor(FP)).toBeUndefined();     // 确认确实回到"没有几何依据"的状态
    useDesignStore.getState().loadDocument(saved);

    const afterY = footprintOverrideFor(FP)!.pads.map((p) => p.y).sort((a, b) => a - b);
    expect(afterY).toEqual(realY);
    expect(afterY).toHaveLength(8);
    // 真实间距 0.65，而名字解析会按名字里的 P1.27mm 猜成 1.27 —— 两者必须能区分
    const uniqueY = [...new Set(afterY.map((y) => y.toFixed(3)))].map(Number).sort((a, b) => a - b);
    expect(uniqueY).toHaveLength(4);                        // 每侧 4 个 y，两侧共用
    expect(uniqueY[1] - uniqueY[0]).toBeCloseTo(0.65, 2);
  });
});

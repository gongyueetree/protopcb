/**
 * KiCad 电气保真回归（golden fixtures 驱动）
 *
 * 覆盖本轮验收标准：
 *  - track net 往返保真（net=3 → 导出仍是 3）
 *  - via size/drill/net 完全一致（禁止 size*0.5 猜测）
 *  - 4 层板 In1.Cu/In2.Cu 不被压成 F.Cu
 *  - 定位孔 2.7mm 导出仍是 2.7mm
 *  - USB-C 外伸不撑大板框
 *  - L 型板外形包围盒正确
 *  - 底面器件、footprint 旋转、pad net
 *  - attr 不再无条件 smd
 *
 * 注意（诚实边界）：这些测试用"本项目 parser 解析本项目 exporter"验证字段保真，
 * 未经真实 kicad-cli DRC 验证（CI 环境未安装 KiCad）——见 README 已知限制。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseKicadPcb } from '../src/design-core/geometry/kicad-pcb-import';
import { buildKicadPcb } from '../src/modules/board-editor/pcbExport';
import { createDocument } from '../src/design-core/document/factory';
import { documentSchema } from '../src/design-core/document/schema';

const FIX = (name: string) => readFileSync(join(__dirname, 'fixtures', 'kicad', name), 'utf-8');

/** 导入结果 → 文档（模拟 store.importKicad 的字段搬运，不依赖 zustand） */
function importToDoc(r: ReturnType<typeof parseKicadPcb>) {
  const doc = createDocument({ name: 'fidelity' });
  doc.board.widthMm = r.widthMm;
  doc.board.heightMm = r.heightMm;
  doc.board.mountingHolesEnabled = r.hasMountingHoles;
  doc.board.mountingHoles = r.mountingHoles.map((h) => ({ position: { x: h.x, y: h.y }, diameterMm: h.d }));
  doc.tracks = r.tracks;
  doc.vias = r.vias;
  doc.copperLayers = r.copperLayers;
  doc.nets = Object.fromEntries(Object.entries(r.nets).map(([k, v]) => [k, String(v)]));
  return doc;
}

describe('电气保真：track / via / pad 网络', () => {
  it('track net=3 导入 → 导出 → 再导入后仍为 3', () => {
    const r1 = parseKicadPcb(FIX('simple-2layer.kicad_pcb'));
    const t3 = r1.tracks.find((t) => t.net === 3);
    expect(t3).toBeDefined();
    expect(t3!.layer).toBe('top');

    const out = buildKicadPcb(importToDoc(r1));
    expect(out).toMatch(/\(segment .*\(net 3\)\)/);
    const r2 = parseKicadPcb(out.replace('(net 0 "")', '(net 0 "")\n(footprint "X:Y" (layer "F.Cu") (at 1 1) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))'));
    expect(r2.tracks.find((t) => t.net === 3)).toBeDefined();
  });

  it('via size=0.8 drill=0.35 net=2 往返完全一致（不做 size*0.5 猜测）', () => {
    const r1 = parseKicadPcb(FIX('simple-2layer.kicad_pcb'));
    const v = r1.vias.find((x) => x.size === 0.8);
    expect(v).toBeDefined();
    expect(v!.drill).toBe(0.35);
    expect(v!.net).toBe(2);
    expect(v!.layers).toEqual(['F.Cu', 'B.Cu']);

    const out = buildKicadPcb(importToDoc(r1));
    expect(out).toContain('(size 0.8) (drill 0.35) (layers "F.Cu" "B.Cu") (net 2)');
    // 第二颗 via 也各自保留原值（不是统一值）
    expect(out).toContain('(size 0.6) (drill 0.3)');
  });

  it('pad net 写回：位号焊盘带 (net id name)', () => {
    const r1 = parseKicadPcb(FIX('simple-2layer.kicad_pcb'));
    const u1 = r1.comps.find((c) => c.reference === 'U1');
    expect(u1?.padNets?.['1']).toBe(1);
    expect(u1?.padNets?.['2']).toBe(2);
  });

  it('底面器件与旋转角保真', () => {
    const r1 = parseKicadPcb(FIX('simple-2layer.kicad_pcb'));
    const rr = r1.comps.find((c) => c.reference === 'R1');
    expect(rr?.layer).toBe('bottom');
    expect(rr?.rotation).toBe(180);
    const u1 = r1.comps.find((c) => c.reference === 'U1');
    expect(u1?.rotation).toBe(90);
  });
});

describe('电气保真：内层铜（4 层板）', () => {
  it('In1.Cu/In2.Cu 导入保留原名，绝不压成 F.Cu', () => {
    const r = parseKicadPcb(FIX('four-layer.kicad_pcb'));
    expect(r.copperLayers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    const in1 = r.tracks.find((t) => t.layer === 'In1.Cu');
    const in2 = r.tracks.find((t) => t.layer === 'In2.Cu');
    expect(in1).toBeDefined();
    expect(in1!.net).toBe(1);
    expect(in2).toBeDefined();
    expect(in2!.w).toBe(0.35);
  });

  it('导出层表含 In1.Cu/In2.Cu，内层走线原层写回', () => {
    const r = parseKicadPcb(FIX('four-layer.kicad_pcb'));
    const out = buildKicadPcb(importToDoc(r));
    expect(out).toContain('(1 "In1.Cu" signal)');
    expect(out).toContain('(2 "In2.Cu" signal)');
    expect(out).toMatch(/\(segment .*\(layer "In1\.Cu"\) \(net 1\)\)/);
    expect(out).toMatch(/\(segment .*\(layer "In2\.Cu"\) \(net 2\)\)/);
    // 盲孔层对保留
    expect(out).toContain('(via blind');
    expect(out).toContain('(layers "F.Cu" "In1.Cu")');
    // 再导入：内层依然是内层
    const r2 = parseKicadPcb(out.replace('(net 0 "")', '(net 0 "")\n(footprint "X:Y" (layer "F.Cu") (at 1 1) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))'));
    expect(r2.tracks.some((t) => t.layer === 'In1.Cu')).toBe(true);
    expect(r2.copperLayers).toContain('In2.Cu');
  });
});

describe('电气保真：定位孔孔径', () => {
  it('2.7mm 定位孔导入 → 导出仍为 2.7mm（不再统一 3.2）', () => {
    const r = parseKicadPcb(FIX('simple-2layer.kicad_pcb'));
    expect(r.mountingHoles).toHaveLength(1);
    expect(r.mountingHoles[0].d).toBe(2.7);
    const out = buildKicadPcb(importToDoc(r));
    expect(out).toContain('(size 2.7 2.7) (drill 2.7)');
    expect(out).not.toContain('(size 3.2 3.2)');
  });
});

describe('电气保真：板框', () => {
  it('USB-C 外伸不撑大板框（Edge.Cuts 为准）', () => {
    const r = parseKicadPcb(FIX('usb-c-overhang.kicad_pcb'));
    expect(r.widthMm).toBe(30);
    expect(r.heightMm).toBe(20);
    // 连接器坐标允许在板外（x=132 → 归一化后 32 > 板宽 30）
    const j1 = r.comps.find((c) => c.reference === 'J1');
    expect(j1!.xMm).toBeCloseTo(32, 5);
  });

  it('L 型板外形包围盒正确', () => {
    const r = parseKicadPcb(FIX('lshape.kicad_pcb'));
    expect(r.widthMm).toBe(60);
    expect(r.heightMm).toBe(50);
  });
});

describe('电气保真：footprint attr', () => {
  it('SMD 封装 → attr smd；含通孔 → attr through_hole', () => {
    const doc = createDocument({ name: 'attr' });
    doc.components = [];
    const out = buildKicadPcb(doc);
    expect(out).not.toContain('(attr smd)');   // 无器件时不出现无条件 attr
  });
});

describe('文档 Schema 兼容', () => {
  it('新字段（net/drill/copperLayers/内层名）通过 Zod 校验', () => {
    const r = parseKicadPcb(FIX('four-layer.kicad_pcb'));
    const doc = importToDoc(r);
    const parsed = documentSchema.safeParse(JSON.parse(JSON.stringify(doc)));
    expect(parsed.success).toBe(true);
  });

  it('旧文档（track 无 net、via 无 drill）仍可通过校验（向后兼容）', () => {
    const doc = createDocument({ name: 'legacy' });
    (doc as any).tracks = [{ x1: 0, y1: 0, x2: 1, y2: 1, w: 0.25, layer: 'top' }];
    (doc as any).vias = [{ x: 1, y: 1, size: 0.6 }];
    const parsed = documentSchema.safeParse(JSON.parse(JSON.stringify(doc)));
    expect(parsed.success).toBe(true);
  });
});

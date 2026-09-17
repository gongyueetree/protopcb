/**
 * Altium .SchDoc 导入 golden（真实工程 Nano_Debug 的原理图）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAltiumSch } from '../../src/design-core/geometry/altium-sch-import';

const FIXTURE = fileURLToPath(new URL('../fixtures/altium-nano-debug.SchDoc', import.meta.url));
const parse = () => parseAltiumSch(new Uint8Array(readFileSync(FIXTURE)));

describe('器件与符号', () => {
  const r = parse();

  it('53 个器件，每个都有符号几何', () => {
    expect(r.instances).toHaveLength(53);
    expect(Object.keys(r.symbolsByRef)).toHaveLength(53);
    for (const i of r.instances) expect(r.symbolsByRef[i.ref]).toBeDefined();
  });

  it('管脚数与器件类型相符（不重复计入多套画法）', () => {
    // 电阻/电容 2 脚；AD 的器件常带 2~3 套 DISPLAYMODE 画法，不过滤会变成 6 脚
    expect(r.symbolsByRef.R1.pins).toHaveLength(2);
    expect(r.symbolsByRef.C1.pins).toHaveLength(2);
    expect(r.symbolsByRef.U1.pins).toHaveLength(64);    // TQFP-32 的符号按 64 个管脚记录画
    const total = Object.values(r.symbolsByRef).reduce((a, s) => a + s.pins.length, 0);
    expect(total).toBe(241);
  });

  it('符号几何是局部坐标（以器件原点为中心）', () => {
    const r1 = r.symbolsByRef.R1;
    for (const p of r1.pins) {
      expect(Math.abs(p.tipX)).toBeLessThan(20);
      expect(Math.abs(p.tipY)).toBeLessThan(20);
    }
    expect(r1.w).toBeGreaterThan(0);
  });

  it('实例带位置与旋转，位号与值来自参数记录', () => {
    const u1 = r.instances.find((i) => i.ref === 'U1')!;
    expect(u1.value).toContain('ATSAMD21E');
    expect(Number.isFinite(u1.x) && Number.isFinite(u1.y)).toBe(true);
    expect([0, 90, 180, 270]).toContain(u1.rot);
  });
});

describe('连线与标签', () => {
  const r = parse();

  it('161 条连线、42 个结点', () => {
    expect(r.wires).toHaveLength(161);
    expect(r.junctions).toHaveLength(42);
    for (const w of r.wires) expect(w.length).toBeGreaterThanOrEqual(2);
  });

  it('网络标签与电源端口都收进来，且区分类型', () => {
    expect(r.labels.length).toBeGreaterThan(100);
    expect(r.labels.some((l) => l.kind === 'local')).toBe(true);
    expect(r.labels.some((l) => l.kind === 'global')).toBe(true);   // 电源端口
    expect(r.labels.every((l) => Number.isFinite(l.x) && Number.isFinite(l.y))).toBe(true);
  });

  it('坐标已翻转成画布方向（Y 向下）', () => {
    const ys = r.instances.map((i) => i.y);
    expect(Math.max(...ys)).toBeLessThan(0);      // AD 的 Y 向上，翻转后全为负
  });
});

describe('健壮性', () => {
  it('空内容报明确错误而不是产出空图', () => {
    expect(() => parseAltiumSch(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it('输出结构与 KiCad 原理图同构（可直接进文档）', () => {
    const r = parse();
    for (const key of ['instances', 'wires', 'junctions', 'labels', 'noConnects', 'buses', 'busEntries', 'sheets']) {
      expect(Array.isArray((r as unknown as Record<string, unknown>)[key])).toBe(true);
    }
    expect(typeof r.libSymbols).toBe('object');
    expect(typeof r.refToLibId).toBe('object');
  });
});

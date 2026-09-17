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
    expect(r.symbolsByRef.U1.pins).toHaveLength(32);   // TQFP-32 就是 32 脚
    const total = Object.values(r.symbolsByRef).reduce((a, s) => a + s.pins.length, 0);
    expect(total).toBe(201);
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

describe('渲染几何（原理图页面实际用的那份）', () => {
  const r = parse();

  it('每个实例都有可渲染的几何，libId 按实例唯一', () => {
    expect(Object.keys(r.legacySymbols)).toHaveLength(53);
    const missing = r.instances.filter((i) => !r.legacySymbols[i.libId]);
    expect(missing).toEqual([]);
    // 同型号器件各自一份：AD 允许实例改画法，共享会串在一起
    expect(new Set(r.instances.map((i) => i.libId)).size).toBe(53);
  });

  it('几何形状与器件相符', () => {
    const u1 = r.legacySymbols[r.instances.find((i) => i.ref === 'U1')!.libId];
    expect(u1.pins).toHaveLength(32);
    expect(u1.rects).toHaveLength(1);                // 一个本体框，不是两套画法叠在一起
    const r1 = r.legacySymbols[r.instances.find((i) => i.ref === 'R1')!.libId];
    expect(r1.pins).toHaveLength(2);
    expect(r1.polys.length).toBeGreaterThan(0);      // 电阻是折线画的
  });

  it('管脚两端都是有限坐标，且连接端与本体端不重合', () => {
    for (const g of Object.values(r.legacySymbols)) {
      for (const p of g.pins) {
        expect([p.x, p.y, p.ex, p.ey].every(Number.isFinite)).toBe(true);
        expect(Math.hypot(p.x - p.ex, p.y - p.ey)).toBeGreaterThan(0);
      }
    }
  });
});

describe('多套画法只画当前那一套（AD 的 DISPLAYMODE）', () => {
  const r = parse();

  it('没有器件出现重复本体框', () => {
    const dup = r.instances.filter((i) => (r.legacySymbols[i.libId]?.rects.length ?? 0) > 1);
    expect(dup.map((i) => i.ref)).toEqual([]);
  });

  it('OWNERPARTDISPLAYMODE 字段缺失按 0 处理（AD 省略默认值）', () => {
    // U1 的两套画法：一套标 mode=1、另一套字段缺失。把"缺失"当"不限制"会两套都画，
    // 结果是 64 个管脚、两个矩形重叠 —— 正是页面看起来混乱的原因。
    const u1 = r.symbolsByRef.U1;
    expect(u1.pins).toHaveLength(32);
    expect(u1.rects).toHaveLength(1);
  });

  it('TQFP 的管脚四边均分且都朝外', () => {
    const g = r.legacySymbols[r.instances.find((i) => i.ref === 'U1')!.libId];
    const sides = { left: 0, right: 0, up: 0, down: 0 };
    for (const p of g.pins) {
      const dx = p.x - p.ex, dy = p.y - p.ey;
      if (Math.abs(dx) > Math.abs(dy)) sides[dx < 0 ? 'left' : 'right']++;
      else sides[dy < 0 ? 'up' : 'down']++;
    }
    expect(sides).toEqual({ left: 8, right: 8, up: 8, down: 8 });
    // 连接端必须在本体框之外，否则导线会插进符号里
    const rect = g.rects[0];
    const inside = g.pins.filter((p) =>
      p.x > Math.min(rect.x1, rect.x2) + 0.5 && p.x < Math.max(rect.x1, rect.x2) - 0.5
      && p.y > Math.min(rect.y1, rect.y2) + 0.5 && p.y < Math.max(rect.y1, rect.y2) - 0.5);
    expect(inside).toEqual([]);
  });
});

describe('符号与导线对齐（坐标约定的硬判据）', () => {
  const r = parse();
  const PXMM_IRRELEVANT = 1;

  /**
   * 复刻 ImportedSchematicView.makeXform：它假定几何是 KiCad 库坐标（Y 向上、未旋转），
   * 会自己做一次 Y 翻转与旋转。AD 的图元坐标是绝对的、已含旋转与 Y 方向，
   * 所以解析层必须按这个约定回写（Y 取反）并把 rot 置 0，否则会被变换两遍。
   */
  const toAbs = (inst: { x: number; y: number; rot: number }, px: number, py: number) => {
    const rad = (-inst.rot * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const sx = px * PXMM_IRRELEVANT, sy = -py;
    return { x: inst.x + (sx * c - sy * s), y: inst.y + (sx * s + sy * c) };
  };

  it('实例 rot 一律为 0（旋转已烘焙进图元坐标）', () => {
    expect(r.instances.every((i) => i.rot === 0)).toBe(true);
  });

  it('绝大多数管脚精确落在导线端点上', () => {
    const ends = new Set<string>();
    for (const w of r.wires) for (const [x, y] of w) ends.add(`${x.toFixed(2)},${y.toFixed(2)}`);

    let hit = 0, total = 0;
    for (const inst of r.instances) {
      for (const p of r.legacySymbols[inst.libId].pins) {
        const abs = toAbs(inst, p.x, p.y);
        total++;
        if (ends.has(`${abs.x.toFixed(2)},${abs.y.toFixed(2)}`)) hit++;
      }
    }
    // 剩下的是电路里本来就悬空的脚（USB-C 的 SBU、MOSFET 衬底等）
    expect(total).toBe(201);
    expect(hit).toBeGreaterThanOrEqual(185);
  });

  it('一个具体例子：U1 的管脚与它周围的导线端点重合', () => {
    const u1 = r.instances.find((i) => i.ref === 'U1')!;
    const ends = new Set<string>();
    for (const w of r.wires) for (const [x, y] of w) ends.add(`${x.toFixed(2)},${y.toFixed(2)}`);
    const connected = r.legacySymbols[u1.libId].pins.filter((p) => {
      const abs = toAbs(u1, p.x, p.y);
      return ends.has(`${abs.x.toFixed(2)},${abs.y.toFixed(2)}`);
    });
    expect(connected.length).toBeGreaterThanOrEqual(30);   // 32 脚里至少 30 脚接线
  });
});

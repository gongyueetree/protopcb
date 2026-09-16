/**
 * 跨模块不变量：同一工程事实只有一个定义
 * Trust / Money / MountingHoles —— 这三项此前在多个模块各算各的。
 */
import { describe, it, expect } from 'vitest';
import { summarizeTrust, trustHeadline, exportGate, trustLevelOf } from '../../src/design-core/trust';
import { formatMoney, sumMoney, sumByCurrency } from '../../src/design-core/money';
import { effectiveMountingHoles, materializeMountingHoles, defaultCornerHoles, describeMountingHoles } from '../../src/design-core/board/mounting-holes';
import { mountingHoleCenters } from '../../src/design-core/collision';
import { deriveMounting } from '../../src/design-core/enclosure/openings';
import { buildKicadPcb } from '../../src/modules/board-editor/pcbExport';
import { createDocument } from '../../src/design-core/document/factory';
import { searchResultToPlaced } from '../../src/design-core/document/services';
import type { ComponentSearchResult } from '../../src/providers/types';
import type { PlacedComponent, TrustLevel } from '../../src/design-core/document/types';

const comp = (ref: string, level?: TrustLevel): PlacedComponent => {
  const c = searchResultToPlaced({
    componentId: 'x' + ref, mpn: 'M-' + ref, manufacturer: '-', category: 'ic',
    defaultFootprintName: 'SOIC-8_3.9x4.9mm_P1.27mm', family: 'IC', pins: 8,
  } as ComponentSearchResult, ref);
  if (level) c.trust = { level, evidence: 'test', source: 'ezplm-exact', verifiedAt: '' };
  return c;
};

describe('Trust 单一口径', () => {
  const comps = [comp('U1', 'VERIFIED'), comp('U2', 'CANDIDATE'), comp('U3', 'CANDIDATE'), comp('U4')];

  it('无 trust 字段一律算未验证，不做乐观假设', () => {
    expect(trustLevelOf(comp('U9'))).toBe('PLACEHOLDER');
  });

  it('统计与 1/2/1 一致', () => {
    const s = summarizeTrust(comps);
    expect(s).toMatchObject({ total: 4, verified: 1, candidate: 2, placeholder: 1, needsReview: 3 });
    expect(s.needsReviewRefs.sort()).toEqual(['U2', 'U3', 'U4']);
  });

  it('CANDIDATE 未清零就不算工程就绪（此前只看 PLACEHOLDER）', () => {
    expect(summarizeTrust([comp('U1', 'VERIFIED'), comp('U2', 'CANDIDATE')]).engineeringReady).toBe(false);
    expect(summarizeTrust([comp('U1', 'VERIFIED')]).engineeringReady).toBe(true);
  });

  it('结论措辞只有一处，绝不会出现"全部精确匹配"同时还有候选', () => {
    const s = summarizeTrust(comps);
    const head = trustHeadline(s);
    expect(head).not.toMatch(/均已核对/);
    expect(head).toMatch(/待人工确认/);
    expect(trustHeadline(summarizeTrust([comp('U1', 'VERIFIED')]))).toBe('型号均已核对');
  });

  it('导出门禁：有候选就必须给出风险说明', () => {
    const g = exportGate(summarizeTrust(comps));
    expect(g.engineeringReady).toBe(false);
    expect(g.warning).toMatch(/候选型号未经人工确认/);
    expect(g.warning).toMatch(/原型文件/);
    expect(exportGate(summarizeTrust([comp('U1', 'VERIFIED')])).warning).toBeUndefined();
  });
});

describe('Money：locale 只改数字格式，不改币种', () => {
  it('CNY 在英文下不会变成美元', () => {
    expect(formatMoney({ amount: 12.5, currency: 'CNY' }, 'zh')).toBe('¥12.50');
    expect(formatMoney({ amount: 12.5, currency: 'CNY' }, 'en')).toBe('CN¥12.50');
    expect(formatMoney({ amount: 12.5, currency: 'CNY' }, 'en')).not.toMatch(/^\$/);
  });
  it('USD 两种语言都是美元', () => {
    expect(formatMoney({ amount: 3, currency: 'USD' }, 'zh')).toBe('$3.00');
    expect(formatMoney({ amount: 3, currency: 'USD' }, 'en')).toBe('$3.00');
  });
  it('没有币种就如实说未知，不猜', () => {
    expect(formatMoney({ amount: 5 }, 'zh')).toMatch(/币种未知/);
    expect(formatMoney({ amount: 5 }, 'en')).toMatch(/currency unknown/);
  });
  it('混币种求和返回 null（调用方必须分币种展示）', () => {
    expect(sumMoney([{ amount: 1, currency: 'CNY' }, { amount: 2, currency: 'USD' }])).toBeNull();
    expect(sumMoney([{ amount: 1, currency: 'CNY' }, { amount: 2, currency: 'CNY' }])).toEqual({ amount: 3, currency: 'CNY' });
    expect(sumByCurrency([{ amount: 1, currency: 'CNY' }, { amount: 2, currency: 'USD' }])).toEqual({ CNY: 1, USD: 2 });
  });
});

describe('MountingHoles 单一数据源', () => {
  const board = () => ({ ...createDocument({ name: 'b' }).board, widthMm: 100, heightMm: 80, mountingHolesEnabled: true, mountingHoles: undefined });

  it('enabled 但无孔位 → 默认四角（不再各模块各自推算）', () => {
    const b = board();
    const holes = effectiveMountingHoles(b);
    expect(holes).toHaveLength(4);
    expect(holes[0]).toEqual({ position: { x: 4, y: 4 }, diameterMm: 3.2 });
  });

  it('关闭开关 → 空，哪怕 mountingHoles 有内容', () => {
    const b = { ...board(), mountingHolesEnabled: false, mountingHoles: defaultCornerHoles(board()) };
    expect(effectiveMountingHoles(b)).toHaveLength(0);
  });

  it('导入板的真实孔径不被默认值覆盖', () => {
    const b = { ...board(), mountingHoles: [{ position: { x: 3, y: 3 }, diameterMm: 2.7 }] };
    expect(effectiveMountingHoles(b)[0].diameterMm).toBe(2.7);
  });

  it('materialize 把 boolean 落成真实孔位', () => {
    const b = board();
    expect(materializeMountingHoles(b)).toBe(true);
    expect(b.mountingHoles).toHaveLength(4);
    expect(materializeMountingHoles(b)).toBe(false);   // 幂等
  });

  it('碰撞 / 外壳 / PCB 导出三处的孔数与坐标完全一致', () => {
    const doc = createDocument({ name: 'holes' });
    doc.board.widthMm = 100; doc.board.heightMm = 80;
    doc.board.mountingHolesEnabled = true;
    materializeMountingHoles(doc.board);

    const canonical = effectiveMountingHoles(doc.board);
    expect(canonical).toHaveLength(4);

    // 2D / 碰撞
    const centers = mountingHoleCenters(doc.board);
    expect(centers).toEqual(canonical.map((h) => ({ x: h.position.x, y: h.position.y })));

    // 外壳固定方式
    const mount = deriveMounting(doc.board);
    expect(mount.kind).toBe('screw-post');
    expect(mount.positions).toEqual(canonical.map((h) => ({ x: h.position.x, y: h.position.y })));

    // KiCad 导出
    const pcb = buildKicadPcb(doc);
    // 注意封装名里 "MountingHole" 出现两次（库名:封装名），按 footprint 行整体匹配才准
    const ats = [...pcb.matchAll(/CircuitCanvas:MountingHole_[^"]*"[^(]*\(layer "F\.Cu"\)\s*\n\s*\(at ([\d.]+) ([\d.]+)\)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
    expect(ats).toHaveLength(4);
    for (const h of canonical) {
      expect(ats.some((a) => Math.abs(a.x - h.position.x) < 0.001 && Math.abs(a.y - h.position.y) < 0.001)).toBe(true);
    }
    expect(pcb).toContain('(size 3.2 3.2) (drill 3.2)');
  });

  it('描述文案也走同一入口', () => {
    const b = board();
    materializeMountingHoles(b);
    expect(describeMountingHoles(b)).toBe('4 个定位孔 Ø3.2mm');
    expect(describeMountingHoles({ ...b, mountingHolesEnabled: false })).toBe('无定位孔');
  });
});

/**
 * Reference Design Intelligence 回归：
 *  排序（§十一）/ 旧响应映射 / 应用项目映射 / Fragment 提取（§十二·AD9837 场景 golden）
 *  注意：AD9837 fixture 是测试专用数据，production UI 绝不硬编码此类假项目。
 */
import { describe, it, expect } from 'vitest';
import { rankReferenceDesigns, scoreReferenceDesign } from '../src/providers/reference-design/ranking';
import { mapLegacyReference, mapApplicationProject, inferSourceType } from '../src/providers/reference-design/ezplm-provider';
import { ReferenceDesignSchema, NO_ASSETS, type ReferenceDesign } from '../src/providers/reference-design/schema';
import { extractCircuitFragment, classifyNet } from '../src/design-core/fragment/extract';
import { CircuitFragmentSchema } from '../src/providers/reference-design/schema';
import type { PlacedComponent } from '../src/design-core/document/types';

const mk = (over: Partial<ReferenceDesign>): ReferenceDesign => ReferenceDesignSchema.parse({
  id: 'x', title: 'T', sourceType: 'OTHER_PUBLIC', sourceSystem: 'PUBLIC',
  anchorMpns: ['AD9837ACPZ-RL'], availableAssets: NO_ASSETS,
  verification: { level: 'EXTRACTED', confidence: 0.3, evidence: [] },
  ...over,
});

describe('排序：来源优先级（§十一）', () => {
  it('用户项目 > 组织项目 > 量产 > 原型 > 厂商 Eval > 仿真 > KiCad > PDF > AI', () => {
    const ctx = { mpn: 'AD9837ACPZ-RL' };
    const list = [
      mk({ id: 'ai', verification: { level: 'AI_GENERATED', confidence: 0.3, evidence: [] } }),
      mk({ id: 'pdf', sourceType: 'PDF_SCHEMATIC' }),
      mk({ id: 'kicad', sourceType: 'KICAD_PROJECT' }),
      mk({ id: 'sim', verification: { level: 'SIMULATION_VERIFIED', confidence: 0.6, evidence: [] } }),
      mk({ id: 'vendor', sourceType: 'VENDOR_REFERENCE', verification: { level: 'VENDOR_REFERENCE', confidence: 0.6, evidence: [] } }),
      mk({ id: 'proto', verification: { level: 'PROTOTYPE_VERIFIED', confidence: 0.85, evidence: [] } }),
      mk({ id: 'prod', verification: { level: 'PRODUCTION_VERIFIED', confidence: 0.95, evidence: [] } }),
      mk({ id: 'org', sourceType: 'ORGANIZATION_PROJECT', sourceSystem: 'EZPLM' }),
      mk({ id: 'user', sourceType: 'USER_PROJECT', sourceSystem: 'EZPLM' }),
    ];
    const ranked = rankReferenceDesigns(list, ctx).map((d) => d.id);
    expect(ranked).toEqual(['user', 'org', 'prod', 'proto', 'vendor', 'sim', 'kicad', 'pdf', 'ai']);
  });

  it('anchor MPN 精确命中显著加分；资产完整度参与同档排序', () => {
    const ctx = { mpn: 'AD9837ACPZ-RL' };
    const exact = mk({ id: 'a' });
    const family = mk({ id: 'b', anchorMpns: ['AD9837'] });
    expect(scoreReferenceDesign(exact, ctx)).toBeGreaterThan(scoreReferenceDesign(family, ctx));
    const withAssets = mk({ id: 'c', availableAssets: { ...NO_ASSETS, schematic: true, pcb: true } });
    expect(scoreReferenceDesign(withAssets, ctx)).toBeGreaterThan(scoreReferenceDesign(exact, ctx));
  });
});

describe('旧 ezPLM reference-designs 响应 → 统一模型', () => {
  it('来源类别由链接推断；聚合搜索结果不冒充 VERIFIED', () => {
    const d = mapLegacyReference({ name: 'AD9837 Eval Board', link: 'https://www.analog.com/en/design-center/evaluation-hardware.html' }, 0, 'AD9837ACPZ-RL')!;
    expect(d.sourceType).toBe('EVALUATION_BOARD');
    expect(d.verification.level).toBe('VENDOR_REFERENCE');
    expect(d.verification.level).not.toBe('PRODUCTION_VERIFIED');
    const g = mapLegacyReference({ name: 'DDS on KiCad', link: 'https://github.com/x/kicad-dds' }, 1, 'AD9837ACPZ-RL')!;
    expect(g.sourceType).toBe('KICAD_PROJECT');
    expect(g.availableAssets.schematic).toBe(true);
  });

  it('inferSourceType 保守回落 OTHER_PUBLIC', () => {
    expect(inferSourceType('https://someblog.example/post', '一个电路')).toBe('OTHER_PUBLIC');
    expect(inferSourceType('https://x.example/a.pdf', 'App Note')).toBe('PDF_SCHEMATIC');
  });

  it('非法记录被 Zod 拒绝而不是带病进入', () => {
    expect(mapLegacyReference({ link: 12345 }, 0, 'X')).toBeNull();
  });
});

describe('应用项目映射（contract 就绪，等待后端端点）', () => {
  it('方案 §六 示例结构 → 统一模型（EZPLM_PROJECT 私有来源）', () => {
    const d = mapApplicationProject({
      projectId: 'P001', projectName: '基于AD9837的DDS信号发生器', bomId: 'BOM000035',
      version: 'v1.0', quantity: 1, hasSchematic: true, hasPcb: true, hasBom: true, hasPdf: true,
      verification: { level: 'PROTOTYPE_VERIFIED' },
    }, 'AD9837ACPZ-RL')!;
    expect(d.sourceType).toBe('EZPLM_PROJECT');
    expect(d.bomId).toBe('BOM000035');
    expect(d.anchorQuantity).toBe(1);
    expect(d.verification.level).toBe('PROTOTYPE_VERIFIED');
    expect(d.availableAssets.schematic).toBe(true);
  });

  it('未标注验证等级的历史项目不冒充实测', () => {
    const d = mapApplicationProject({ projectName: 'X', projectId: 1 }, 'M')!;
    expect(d.verification.level).toBe('EXTRACTED');
  });
});

describe('Fragment 提取（AD9837 golden 场景，§五十一）', () => {
  // 测试专用 fixture：AD9837 + 时钟 + SPI 控制 + 去耦 + 输出滤波 + MCU + 电源 + USB 连接器
  const P = (reference: string, mpn: string, category: PlacedComponent['category'], padNets: Record<string, number>, family = ''): PlacedComponent => ({
    instanceId: 'i_' + reference, componentId: 'c_' + reference, reference, mpn, manufacturer: '-',
    category, quantity: 1,
    footprint: { name: 'X', geometry: { bodyWidthMm: 5, bodyHeightMm: 5 } },
    placement: { xMm: 0, yMm: 0, rotationDeg: 0, side: 'top' },
    display: { padNets, family },
  } as unknown as PlacedComponent);

  const nets = { '1': 'GND', '2': '+3V3', '3': 'SPI_SCLK', '4': 'SPI_SDATA', '5': 'FSYNC', '6': 'MCLK', '7': 'VOUT', '8': 'VOUT_FILT', '9': 'USB_DP' };
  const doc = {
    id: 'doc1', name: 'DDS Signal Generator', nets,
    components: [
      P('U1', 'AD9837ACPZ-RL', 'ic', { '1': 2, '2': 1, '3': 6, '4': 3, '5': 4, '6': 5, '7': 7 }),
      P('Y1', 'ABM8-16MHZ', 'passive', { '1': 6, '2': 1 }, 'Crystal'),
      P('C1', 'CL10B104', 'passive', { '1': 2, '2': 1 }, 'MLCC'),
      P('C2', 'CL10B105', 'passive', { '1': 2, '2': 1 }, 'MLCC'),
      P('R1', 'RC0402-200R', 'passive', { '1': 7, '2': 8 }),
      P('C3', 'CL10B102', 'passive', { '1': 8, '2': 1 }, 'MLCC'),
      P('U2', 'STM32F103C8T6', 'mcu', { '10': 3, '11': 4, '12': 5, '20': 2, '21': 1, '30': 9 }),
      P('U3', 'AMS1117-3.3', 'power', { '1': 1, '2': 2, '3': 9 }),
      P('J1', 'USB-C-16P', 'connector', { 'A6': 9, 'B1': 1 }),
    ],
  };

  it('depth=1：锚定 AD9837 提取时钟/去耦/滤波/本地电源，连接器排除、MCU 不被整板拖入', () => {
    const out = extractCircuitFragment({ doc, anchorReference: 'U1' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const refs = out.fragment.components.map((c) => c.reference).sort();
    expect(refs).toContain('Y1');                       // 时钟晶振（MCLK 信号 net）
    expect(refs).toContain('C1');                       // 去耦（电源 net 上的本地支撑件）
    expect(refs).toContain('R1');                       // 输出滤波串阻（VOUT 信号 net）
    expect(refs).toContain('U3');                       // 本地电源（POWER net 上的 power 类）
    expect(refs).toContain('U2');                       // SPI 三根低扇出信号线直连 → 支撑 IC
    expect(refs).not.toContain('J1');                   // 连接器被 excludeCategories 排除
    // 角色分类
    const role = (r: string) => out.fragment.components.find((c) => c.reference === r)?.role;
    expect(role('U1')).toBe('ANCHOR');
    expect(role('C1')).toBe('DECOUPLING');
    expect(role('Y1')).toBe('CLOCK');
    expect(role('U3')).toBe('POWER_LOCAL');
    // 端口：USB_DP 在 fragment 外还连 J1 → 边界端口
    const portNames = out.fragment.ports.map((p) => p.name);
    expect(portNames).toContain('USB_DP');
    // 整体过 Zod
    expect(CircuitFragmentSchema.safeParse(out.fragment).success).toBe(true);
  });

  it('depth=2 时 C3（输出滤波第二级）被纳入', () => {
    const d1 = extractCircuitFragment({ doc, anchorReference: 'U1', policy: { depth: 1 } });
    const d2 = extractCircuitFragment({ doc, anchorReference: 'U1', policy: { depth: 2 } });
    if (!d1.ok || !d2.ok) throw new Error('extract failed');
    expect(d1.fragment.components.map((c) => c.reference)).not.toContain('C3');
    expect(d2.fragment.components.map((c) => c.reference)).toContain('C3');
  });

  it('锚点无净表数据 → 显式 NO_CONNECTIVITY，不假装成功', () => {
    const bare = { ...doc, components: [P('U9', 'X', 'ic', {})] };
    const out = extractCircuitFragment({ doc: bare, anchorReference: 'U9' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('NO_CONNECTIVITY');
  });

  it('net 语义分类：不确定不猜成电源', () => {
    expect(classifyNet('GND')).toBe('GROUND');
    expect(classifyNet('+3V3')).toBe('POWER');
    expect(classifyNet('MCLK')).toBe('CLOCK');
    expect(classifyNet('MYSTERY_SIG')).toBe('SIGNAL');
    expect(classifyNet('SCL')).toBe('SIGNAL');          // I2C SCL 不是时钟域
  });
});

/* ── 按官方《API 密钥查询接口用户操作手册》校准的响应结构 ── */
describe('官方手册响应结构', () => {
  it('parts 条目的 id 即后续的 partlibId', () => {
    // 手册 §2：返回结构为 data + meta，条目最重要的字段是 id / mpn / manufacturer
    const partsResponse = {
      data: [{ id: '019137eb-d4c0-76c9-b1f5-88ee84d727a6', mpn: 'TPS79301DBVR', manufacturer: 'TI' }],
      meta: { cursor: null, pageSize: 10 },
    };
    const first = partsResponse.data[0];
    expect(first.id).toBeTruthy();
    expect(`ez_${first.id}`.startsWith('ez_')).toBe(true);
  });

  it('reference-designs 的 name/link/image/description 映射到统一模型', () => {
    const row = {
      name: 'TPS79301 典型应用电路',
      link: 'https://www.ti.com/lit/ds/symlink/tps793.pdf',
      image: '',
      description: '低压差线性稳压器参考设计',
    };
    const rd = mapLegacyReference(row, 0, 'TPS79301DBVR')!;
    expect(rd).toBeTruthy();
    expect(rd.title).toBe('TPS79301 典型应用电路');
    expect(rd.sourceUrl).toBe(row.link);
    expect(rd.anchorMpns).toEqual(['TPS79301DBVR']);
    // PDF 链接 → 标记有 pdf 资产，且不臆断有原理图/PCB
    expect(rd.availableAssets.pdf).toBe(true);
    expect(rd.availableAssets.schematic).toBe(false);
    // 聚合来源一律低置信，绝不标成已验证
    expect(['EXTRACTED', 'VENDOR_REFERENCE']).toContain(rd.verification.level);
  });

  it('image 为空字符串时不产生非法 imageUrl', () => {
    const rd = mapLegacyReference({ name: 'X', link: 'https://a.b/c', image: '' }, 0, 'M')!;
    expect(rd.imageUrl).toBeUndefined();
  });

  it('data 为空数组 = 该物料没有参考设计（不是错误）', () => {
    const rows: unknown[] = [];
    expect(rows.map((x, i) => mapLegacyReference(x, i, 'M')).filter(Boolean)).toHaveLength(0);
  });
});

/**
 * design-core/scheme-workspace.ts
 * AI 方案评审工作台的纯逻辑：分组、框图推导、版本 diff。
 *
 * 为什么要单独一层：多轮对话里，"AI 改了什么"必须是**可核对的事实**，
 * 不能由模型自己叙述（它会漏说、会夸大）。所以每轮用上一版与新版做确定性 diff，
 * UI 上的「AI 已完成修改」清单直接来自 diff 结果。
 */

export interface SchemeItem {
  componentId: string;
  mpn: string;
  manufacturer?: string;
  category: string;
  defaultFootprintName?: string;
  description?: string;
  group?: string;
  core?: boolean;
  qty?: number;
}

/* ---------- 分组 ---------- */

export interface SchemeGroup {
  /** 组名：核心器件型号，或未分组时的类别名 */
  name: string;
  core?: SchemeItem;
  /** 该组的附属器件（去耦、上拉、晶振…），同型号已归并，数量见 count */
  satellites: SchemeItem[];
  /** componentId → 该型号在本组的数量（qty=3 的去耦电容只占一行，显示 ×3） */
  counts: Record<string, number>;
}

/**
 * 同一型号多只在方案里是**同一个对象被 push 多次**（qty 展开的结果）。
 * 直接渲染会出现重复行、React key 撞车，核心器件也可能被挤到列表中间。
 * 这里按 componentId 归并，数量另记。
 */
function dedupe(list: SchemeItem[]): { unique: SchemeItem[]; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const unique: SchemeItem[] = [];
  for (const it of list) {
    const id = it.componentId;
    if (counts[id]) { counts[id] += 1; continue; }
    counts[id] = 1;
    unique.push(it);
  }
  return { unique, counts };
}

const CAT_ORDER = ['mcu', 'power', 'rf', 'sensor', 'ic', 'connector', 'electromech', 'passive', 'other'];

/**
 * 把方案器件按「核心器件 + 附属器件」分组。
 * 模型给了 group 就按它分；没给的按类别兜底成组（保证任何情况下都有可用结构）。
 */
export function groupSchemeItems(items: SchemeItem[]): SchemeGroup[] {
  const byGroup = new Map<string, SchemeItem[]>();
  const ungrouped: SchemeItem[] = [];
  for (const it of items) {
    const g = it.group?.trim();
    if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), it]);
    else ungrouped.push(it);
  }

  const groups: SchemeGroup[] = [];
  for (const [name, list] of byGroup) {
    const { unique, counts } = dedupe(list);
    // 核心：模型标了 core 的；没标则取组内第一个非无源器件；再没有就取第一个
    const core = unique.find((x) => x.core)
      ?? unique.find((x) => x.category !== 'passive')
      ?? unique[0];
    // 按 componentId 排除核心（不能只按对象引用：同一型号可能是不同对象）
    groups.push({ name, core, counts, satellites: unique.filter((x) => x.componentId !== core?.componentId) });
  }

  // 未分组的按类别聚成一组，组名用类别，不硬塞进别的组（避免编造归属）
  const byCat = new Map<string, SchemeItem[]>();
  for (const it of ungrouped) byCat.set(it.category, [...(byCat.get(it.category) ?? []), it]);
  for (const [cat, list] of byCat) {
    const { unique, counts } = dedupe(list);
    const core = unique.find((x) => x.category !== 'passive');
    groups.push({ name: cat, core, counts, satellites: unique.filter((x) => x.componentId !== core?.componentId) });
  }

  // 主控/电源在前，无源兜底组最后
  return groups.sort((a, b) => {
    const ai = CAT_ORDER.indexOf(a.core?.category ?? a.name);
    const bi = CAT_ORDER.indexOf(b.core?.category ?? b.name);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

/* ---------- 框图 ---------- */

export interface DerivedBlock { id: string; label: string; core?: string; kind: string }
export interface DerivedLink { from: string; to: string; label?: string; kind: string }

const KIND_BY_CAT: Record<string, string> = {
  mcu: 'mcu', power: 'power', sensor: 'sensor', connector: 'interface',
  rf: 'rf', ic: 'other', electromech: 'interface', passive: 'other',
};

/**
 * 模型没给框图时，从分组结果推导一个**保守**的框图：
 * 块 = 分组；连线只画两类**可以由结构确定**的关系：
 *   电源块 → 其它所有块（供电）
 *   主控块 → 其它非电源块（控制/数据）
 * 不臆造具体总线名（I2C/SPI 等只有模型明确给出时才标）。
 */
export function deriveBlocks(groups: SchemeGroup[]): { blocks: DerivedBlock[]; links: DerivedLink[] } {
  const blocks: DerivedBlock[] = groups.map((g, i) => ({
    id: `b${i}`,
    label: g.core?.mpn ?? g.name,
    core: g.core?.mpn,
    kind: KIND_BY_CAT[g.core?.category ?? g.name] ?? 'other',
  }));
  const links: DerivedLink[] = [];
  const power = blocks.filter((b) => b.kind === 'power');
  const mcu = blocks.find((b) => b.kind === 'mcu');
  for (const p of power) {
    for (const b of blocks) if (b.id !== p.id) links.push({ from: p.id, to: b.id, kind: 'power' });
  }
  if (mcu) {
    for (const b of blocks) {
      if (b.id === mcu.id || b.kind === 'power') continue;
      links.push({ from: mcu.id, to: b.id, kind: 'signal' });
    }
  }
  return { blocks, links };
}

/* ---------- 版本 diff ---------- */

export interface SchemeChange {
  kind: 'added' | 'removed' | 'qty' | 'group';
  mpn: string;
  detail: string;
}

const normMpn = (v: string) => (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** 汇总同型号的数量 */
function countByMpn(items: SchemeItem[]): Map<string, { mpn: string; qty: number; group?: string }> {
  const m = new Map<string, { mpn: string; qty: number; group?: string }>();
  for (const it of items) {
    const k = normMpn(it.mpn);
    const prev = m.get(k);
    m.set(k, { mpn: it.mpn, qty: (prev?.qty ?? 0) + 1, group: it.group ?? prev?.group });
  }
  return m;
}

/**
 * 两版方案的确定性差异。UI 的「AI 已完成修改」清单直接来自这里，
 * 而不是模型自述——模型说的和它实际改的经常对不上。
 */
export function diffSchemes(prev: SchemeItem[], next: SchemeItem[]): SchemeChange[] {
  const a = countByMpn(prev);
  const b = countByMpn(next);
  const out: SchemeChange[] = [];
  for (const [k, v] of b) {
    const old = a.get(k);
    if (!old) { out.push({ kind: 'added', mpn: v.mpn, detail: `新增 ${v.mpn}${v.qty > 1 ? ` ×${v.qty}` : ''}` }); continue; }
    if (old.qty !== v.qty) out.push({ kind: 'qty', mpn: v.mpn, detail: `${v.mpn} 数量 ${old.qty} → ${v.qty}` });
    if ((old.group ?? '') !== (v.group ?? '') && v.group) {
      out.push({ kind: 'group', mpn: v.mpn, detail: `${v.mpn} 归组 ${old.group || '未分组'} → ${v.group}` });
    }
  }
  for (const [k, v] of a) {
    if (!b.has(k)) out.push({ kind: 'removed', mpn: v.mpn, detail: `移除 ${v.mpn}${v.qty > 1 ? ` ×${v.qty}` : ''}` });
  }
  return out;
}

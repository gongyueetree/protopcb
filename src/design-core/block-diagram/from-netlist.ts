/**
 * design-core/block-diagram/from-netlist.ts
 * 按**真实网表**推导功能框图 —— 导入 KiCad 工程后，每颗核心器件自成一个功能块，
 * 块间连线来自两块之间实际共享的信号网络。
 *
 * 为什么不按类别分组：一块板上有 7 颗 IC，"外设IC" 一个框把它们全装进去，
 * 既看不出谁连谁，也看不出各自的功能 —— 那不是框图，只是个清单。
 *
 * 确定性规则（全部可核对）：
 *   块 = 每颗非无源核心器件（IC/MCU/电源/连接器/晶振…），附属无源件归到它最相关的块
 *   连线 = 两块之间共享的信号网络；电源/地网络单独标注为电源连接，不画成满屏网状
 *   标签 = 共享网络名（最多两个），没有名字的网络显示网络数
 */
import { classifyNet, isCommonRail } from '../semantics/net';
import type { CircuitCanvasDocument, PlacedComponent } from '../document/types';

export interface NetBlock {
  id: string;
  label: string;
  sublabel: string;
  kind: 'mcu' | 'power' | 'interface' | 'ic' | 'clock' | 'other';
  componentIds: string[];
  /** 该块的核心器件位号 */
  coreRef: string;
}
export interface NetLink {
  from: string;
  to: string;
  label: string;
  kind: 'power' | 'signal';
  /** 共享的网络号，便于回查 */
  nets: number[];
}

/**
 * 网络是否公共轨（电源/地）：走统一的 NetSemanticClassifier。
 * 此前这里自己维护一个 POWER_NAME 且把 VIN/VOUT 一律当电源 —— 与 fragment 的判定互相矛盾。
 * 现在带上"连到它的器件类别"作证据：LDO 上的 VOUT 是电源轨，DAC 上的 VOUT 是模拟信号。
 */
function isRail(doc: CircuitCanvasDocument, netId: number): boolean {
  const name = doc.nets?.[String(netId)] ?? '';
  const pins = doc.components
    .filter((c) => Object.values(c.display?.padNets ?? {}).includes(netId))
    .map((c) => ({ componentCategory: c.category }));
  const kind = classifyNet({ name, pins });
  if (kind === 'UNKNOWN' && /^(VIN|VOUT)/i.test(name)) {
    // 歧义名、无引脚类型证据：挂在电源类器件上才当轨
    return pins.some((p) => p.componentCategory === 'power');
  }
  return isCommonRail(kind);
}

/** 核心器件判定：非无源即核心；无源件只做附属 */
function isCore(c: PlacedComponent): boolean {
  return c.category !== 'passive';
}

function kindOf(c: PlacedComponent): NetBlock['kind'] {
  const s = `${c.mpn} ${c.footprint.name} ${c.display?.description ?? ''}`.toUpperCase();
  if (c.category === 'mcu' || /MCU|CORTEX|STM32|LPC|GD32|ESP32|RP2040/.test(s)) return 'mcu';
  if (c.category === 'power' || /REGULATOR|LDO|DCDC|BUCK|BOOST|MIC55|AMS1117|LM27|TPS/.test(s)) return 'power';
  if (c.category === 'connector' || /^(J|P|CN|USB)\d/i.test(c.reference)) return 'interface';
  if (/^(X|Y)\d/i.test(c.reference) || /CRYSTAL|OSC/.test(s)) return 'clock';
  if (c.category === 'ic') return 'ic';
  return 'other';
}

const KIND_LABEL: Record<NetBlock['kind'], string> = {
  mcu: '主控', power: '电源', interface: '接口', ic: '功能', clock: '时钟', other: '其它',
};

/**
 * 由文档推导功能块与块间连线。
 * @returns blocks 为空表示没有可用的核心器件；links 为空表示没有 netlist（未导入工程）
 */
export function blocksFromNetlist(doc: CircuitCanvasDocument): { blocks: NetBlock[]; links: NetLink[] } {
  const cores = doc.components.filter(isCore);
  if (!cores.length) return { blocks: [], links: [] };

  // 1) 每颗核心器件一个块
  const blocks: NetBlock[] = cores.map((c) => ({
    id: `nb_${c.instanceId}`,
    label: c.mpn.length > 18 ? c.mpn.slice(0, 16) + '…' : c.mpn,
    sublabel: c.reference,
    kind: kindOf(c),
    componentIds: [c.instanceId],
    coreRef: c.reference,
  }));
  const blockOfRef = new Map(blocks.map((b) => [b.coreRef, b]));

  // 2) 无源件归属：优先 anchorRef（子电路成组），否则归到与它共享网络最多的核心块
  const netMembers = new Map<number, string[]>();          // 网络号 → 位号集合
  for (const c of doc.components) {
    for (const n of Object.values(c.display?.padNets ?? {})) {
      if (!n) continue;
      netMembers.set(n, [...(netMembers.get(n) ?? []), c.reference]);
    }
  }
  for (const c of doc.components) {
    if (isCore(c)) continue;
    const anchor = c.display?.anchorRef && blockOfRef.get(c.display.anchorRef);
    if (anchor) { anchor.componentIds.push(c.instanceId); continue; }
    const score = new Map<string, number>();
    for (const n of Object.values(c.display?.padNets ?? {})) {
      if (!n) continue;
      if (isRail(doc, n)) continue;                           // 电源/地不作为归属依据（人人都连）
      for (const ref of netMembers.get(n) ?? []) {
        if (ref === c.reference || !blockOfRef.has(ref)) continue;
        score.set(ref, (score.get(ref) ?? 0) + 1);
      }
    }
    const best = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) blockOfRef.get(best[0])!.componentIds.push(c.instanceId);
  }

  // 3) 块间连线：两块的核心器件共享同一网络即连一条；电源网络单列
  const pairSignal = new Map<string, { nets: Set<number>; names: Set<string> }>();
  const pairPower = new Map<string, { nets: Set<number>; names: Set<string> }>();
  for (const [net, refs] of netMembers) {
    const coreRefs = [...new Set(refs.filter((r) => blockOfRef.has(r)))];
    if (coreRefs.length < 2) continue;
    const name = doc.nets?.[String(net)] ?? '';
    const isPower = isRail(doc, net);
    // 电源网络常常连接几乎所有器件，全画会变成网状；只在"电源块 → 其它块"方向保留
    for (let i = 0; i < coreRefs.length; i++) {
      for (let j = i + 1; j < coreRefs.length; j++) {
        const a = blockOfRef.get(coreRefs[i])!, b = blockOfRef.get(coreRefs[j])!;
        if (isPower && a.kind !== 'power' && b.kind !== 'power') continue;
        const [from, to] = isPower
          ? (a.kind === 'power' ? [a, b] : [b, a])
          : [a, b];
        const key = `${from.id}|${to.id}`;
        const bag = isPower ? pairPower : pairSignal;
        const cur = bag.get(key) ?? { nets: new Set<number>(), names: new Set<string>() };
        cur.nets.add(net);
        if (name) cur.names.add(name);
        bag.set(key, cur);
      }
    }
  }

  const links: NetLink[] = [];
  const push = (bag: Map<string, { nets: Set<number>; names: Set<string> }>, kind: NetLink['kind']) => {
    for (const [key, v] of bag) {
      const [from, to] = key.split('|');
      const names = [...v.names].slice(0, 2);
      links.push({
        from, to, kind, nets: [...v.nets],
        label: names.length ? names.join('/') + (v.nets.size > names.length ? ` +${v.nets.size - names.length}` : '') : `${v.nets.size} 网`,
      });
    }
  };
  push(pairSignal, 'signal');
  push(pairPower, 'power');
  return { blocks, links };
}

/** 按类型分列排布：接口 → 电源 → 主控 → 功能/时钟 → 其它 */
export function layoutNetBlocks(blocks: NetBlock[], w = 150, h = 68): Record<string, { x: number; y: number }> {
  const order: NetBlock['kind'][] = ['interface', 'power', 'mcu', 'ic', 'clock', 'other'];
  const cols = new Map<NetBlock['kind'], NetBlock[]>();
  for (const b of blocks) cols.set(b.kind, [...(cols.get(b.kind) ?? []), b]);
  const out: Record<string, { x: number; y: number }> = {};
  let col = 0;
  for (const k of order) {
    const list = cols.get(k);
    if (!list?.length) continue;
    list.forEach((b, row) => { out[b.id] = { x: 40 + col * (w + 70), y: 40 + row * (h + 34) }; });
    col++;
  }
  return out;
}

export { KIND_LABEL };

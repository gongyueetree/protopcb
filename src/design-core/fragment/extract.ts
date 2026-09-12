/**
 * design-core/fragment/extract.ts
 * CircuitFragment 提取器（方案 §十二/§十四）—— 纯函数，在真实净表图上遍历。
 *
 * 数据来源：导入 KiCad 工程后文档中已有的真实连接性
 *   doc.nets（网络号→名）+ 每个器件 display.padNets（焊盘→网络号）。
 * 这不是 LLM 猜测：图遍历只使用文件级事实；LLM 仅在后续做语义分类时使用（未接入）。
 *
 * 遍历模型：component–net 二分图。
 *   anchor 起点 → 其所有 net → net 上的其它器件 →（按策略）继续。
 * 防"整板拖入"（§十四核心要求）：
 *   1. POWER/GROUND net 不作为遍历桥梁（否则 GND 一跳带出全板）——
 *      它们记入 fragment.nets，但不经其扩张器件集合；
 *   2. 高扇出 SIGNAL net（连接器件数 > fanoutLimit）视为系统总线，不扩张；
 *   3. depth 限制（默认 1）；
 *   4. include/exclude 角色策略：exclude 的类别（如 SYSTEM_CONNECTOR）不纳入。
 * 边界端口：net 同时连接 fragment 内/外 → FragmentPort（这是拼接点）。
 */
import type { CircuitCanvasDocument, PlacedComponent } from '../document/types';
import type { CircuitFragment, FragmentComponent, FragmentNet, FragmentPort } from '../../providers/reference-design/schema';

export interface FragmentExtractionPolicy {
  /** 遍历深度：1=仅 anchor 直连；2=再扩一跳（默认 1） */
  depth: 1 | 2 | 3;
  /** SIGNAL net 扇出超过该值视为系统总线，不经其扩张（默认 6） */
  fanoutLimit: number;
  /** 排除类别（默认排除连接器 = SYSTEM_CONNECTOR 近似） */
  excludeCategories: string[];
  /** 手动强制包含/排除（位号），优先级最高 */
  includeRefs?: string[];
  excludeRefs?: string[];
}

export const DEFAULT_EXTRACTION_POLICY: FragmentExtractionPolicy = {
  depth: 1,
  fanoutLimit: 6,
  excludeCategories: ['connector'],
};

/** 网络语义分类（名称启发；不确定归 SIGNAL，绝不猜成电源） */
export function classifyNet(name: string): FragmentNet['kind'] {
  const n = name.toUpperCase();
  if (/^(GND|AGND|DGND|PGND|GNDA|GNDD|VSS)/.test(n)) return 'GROUND';
  // VIN/VOUT 刻意不列入：稳压器上是电源轨，但 DAC/ADC/运放上是模拟信号——歧义名不猜成电源
  if (/^(\+?\d+V\d*|VCC|VDD|VBAT|VBUS|AVDD|DVDD|\+3V3|\+5V|\+12V|3V3|5V)/.test(n)) return 'POWER';
  if (/(CLK|XTAL|OSC|MCLK|SCLK(?!.*DATA))/.test(n) && !/SCL$/.test(n)) return 'CLOCK';
  return 'SIGNAL';
}

/** 器件在 fragment 中的角色（可解释启发；LLM 语义分类留作后续增强） */
function classifyRole(c: PlacedComponent, viaNetKind: FragmentNet['kind']): FragmentComponent['role'] {
  const fam = (c.display?.family ?? '').toLowerCase();
  const mpn = c.mpn.toUpperCase();
  if (c.category === 'passive') {
    if (/mlcc|cap/i.test(fam) || /^C/.test(c.reference)) {
      return viaNetKind === 'POWER' || viaNetKind === 'GROUND' ? 'DECOUPLING' : 'FILTER';
    }
    if (/^R/.test(c.reference)) return viaNetKind === 'CLOCK' ? 'CLOCK' : 'CONNECTED_PASSIVE';
    if (/crystal|xtal/i.test(fam) || /^Y/.test(c.reference)) return 'CLOCK';
    if (/^L/.test(c.reference) || /inductor/i.test(fam)) return 'FILTER';
    return 'CONNECTED_PASSIVE';
  }
  if (c.category === 'power') return 'POWER_LOCAL';
  if (/crystal|osc/i.test(fam) || /^Y/.test(c.reference)) return 'CLOCK';
  void mpn;
  return 'SUPPORTING';
}

export interface ExtractInput {
  doc: Pick<CircuitCanvasDocument, 'nets' | 'components' | 'name' | 'id'>;
  anchorReference: string;
  policy?: Partial<FragmentExtractionPolicy>;
}

export type ExtractOutcome =
  | { ok: true; fragment: CircuitFragment }
  | { ok: false; reason: 'ANCHOR_NOT_FOUND' | 'NO_CONNECTIVITY'; detail: string };

/** 从当前文档围绕锚点器件提取 CircuitFragment */
export function extractCircuitFragment(input: ExtractInput): ExtractOutcome {
  const { doc, anchorReference } = input;
  const policy: FragmentExtractionPolicy = { ...DEFAULT_EXTRACTION_POLICY, ...input.policy };

  const anchor = doc.components.find((c) => c.reference === anchorReference);
  if (!anchor) return { ok: false, reason: 'ANCHOR_NOT_FOUND', detail: `位号 ${anchorReference} 不在当前文档` };
  const netNames = doc.nets ?? {};

  // 建立 net → [{ref, pad}] 反向索引（仅使用文件级 padNets 事实）
  const netPins = new Map<number, { ref: string; pad: string }[]>();
  const compByRef = new Map<string, PlacedComponent>();
  for (const c of doc.components) {
    compByRef.set(c.reference, c);
    const pn = c.display?.padNets ?? {};
    for (const [pad, netId] of Object.entries(pn)) {
      if (!Number.isFinite(netId) || netId <= 0) continue;   // net 0 = 无网络
      const arr = netPins.get(netId) ?? [];
      arr.push({ ref: c.reference, pad });
      netPins.set(netId, arr);
    }
  }
  const anchorNets = Object.values(anchor.display?.padNets ?? {}).filter((n) => Number.isFinite(n) && n > 0);
  if (!anchorNets.length) {
    return { ok: false, reason: 'NO_CONNECTIVITY', detail: `${anchorReference} 无净表数据（仅 KiCad 导入工程带 padNets；画布手搭方案暂无连接性）` };
  }

  const kindOf = (netId: number) => classifyNet(String(netNames[String(netId)] ?? ''));
  const canBridge = (netId: number): boolean => {
    const kind = kindOf(netId);
    if (kind === 'POWER' || kind === 'GROUND') return false;                       // 电源/地不作桥
    const fanout = new Set((netPins.get(netId) ?? []).map((p) => p.ref)).size;
    return fanout <= policy.fanoutLimit;                                            // 高扇出 = 系统总线
  };

  // BFS：按 depth 扩张器件集合
  const inFragment = new Map<string, FragmentComponent['role']>();
  inFragment.set(anchor.reference, 'ANCHOR');
  let frontier = [anchor.reference];
  for (let d = 0; d < policy.depth; d++) {
    const next: string[] = [];
    for (const ref of frontier) {
      const c = compByRef.get(ref)!;
      for (const netId of new Set(Object.values(c.display?.padNets ?? {}))) {
        if (!Number.isFinite(netId) || netId <= 0) continue;
        const bridgeable = canBridge(netId);
        for (const pin of netPins.get(netId) ?? []) {
          if (inFragment.has(pin.ref)) continue;
          const other = compByRef.get(pin.ref);
          if (!other) continue;
          if (policy.excludeRefs?.includes(pin.ref)) continue;
          const forced = policy.includeRefs?.includes(pin.ref) ?? false;
          if (!forced) {
            if (policy.excludeCategories.includes(other.category)) continue;        // SYSTEM_CONNECTOR 类
            const kind = kindOf(netId);
            if (!bridgeable) {
              if (kind === 'SIGNAL') continue;                                       // 高扇出信号总线不扩张
              if (kind === 'POWER' || kind === 'GROUND') {
                // 电源/地网不能定义"局部性"：仅吸收
                //  a) 电源类 IC（本地稳压/LDO）；
                //  b) 纯去耦无源件 —— 所有引脚都落在 POWER/GROUND 域（如轨对地电容）。
                // 否则任何一颗远端接地的电容/电阻都会经 GND 一跳被拖入（整板泄漏）。
                const otherKinds = Object.values(other.display?.padNets ?? {})
                  .filter((n) => Number.isFinite(n) && n > 0)
                  .map((n) => kindOf(n));
                const pureDecoupling = other.category === 'passive'
                  && otherKinds.length > 0
                  && otherKinds.every((k) => k === 'POWER' || k === 'GROUND');
                if (!(other.category === 'power' || pureDecoupling)) continue;
              }
            }
          }
          inFragment.set(pin.ref, classifyRole(other, kindOf(netId)));
          next.push(pin.ref);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  // fragment 涉及的 nets + 边界端口
  const nets: FragmentNet[] = [];
  const ports: FragmentPort[] = [];
  const touched = new Set<number>();
  for (const ref of inFragment.keys()) {
    for (const netId of Object.values(compByRef.get(ref)!.display?.padNets ?? {})) {
      if (Number.isFinite(netId) && netId > 0) touched.add(netId);
    }
  }
  for (const netId of [...touched].sort((a, b) => a - b)) {
    const name = String(netNames[String(netId)] ?? `net${netId}`);
    const kind = kindOf(netId);
    const all = netPins.get(netId) ?? [];
    const inside = all.filter((p) => inFragment.has(p.ref));
    const outside = [...new Set(all.filter((p) => !inFragment.has(p.ref)).map((p) => p.ref))];
    nets.push({ netId, name, kind, pins: inside.map((p) => `${p.ref}.${p.pad}`).slice(0, 200) });
    if (outside.length) ports.push({ netId, name, kind, externalRefs: outside.slice(0, 60) });
  }

  const components: FragmentComponent[] = [...inFragment.entries()].map(([ref, role]) => {
    const c = compByRef.get(ref)!;
    return { instanceId: c.instanceId, reference: ref, mpn: c.mpn, category: c.category, footprint: c.footprint.name, role };
  });

  return {
    ok: true,
    fragment: {
      id: `frag_${anchor.reference}_${Date.now().toString(36)}`,
      name: `${anchor.mpn} · ${anchorReference} 功能块`,
      anchorComponent: { mpn: anchor.mpn, reference: anchorReference },
      sourceDesignId: doc.id,
      sourceType: 'KICAD_PROJECT',
      components,
      nets,
      ports,
      // 从导入工程提取的连接性是文件级事实，但功能块边界是启发式划定 → EXTRACTED
      trust: { level: 'EXTRACTED', confidence: 0.7 },
      evidence: [{ kind: 'schematic', detail: `由导入工程 ${doc.name} 的净表围绕 ${anchorReference} 图遍历提取（depth=${policy.depth}）` }],
    },
  };
}

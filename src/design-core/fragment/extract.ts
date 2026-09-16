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
import type { CircuitFragment, FragmentComponent, FragmentNet, FragmentPort } from './schema';
import { classifyNet as classifyNetSemantic, toCoarseKind } from '../semantics/net';

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

/** 网络语义分类：委托统一的 NetSemanticClassifier（design-core/semantics/net），这里只降为 fragment 的 4 类 */
export function classifyNet(name: string): FragmentNet['kind'] {
  return toCoarseKind(classifyNetSemantic({ name }));
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

  // BFS：按 depth 扩张器件集合。
  // ⚠ 同时显式记录**实际被遍历的网络**（traversedNets）：fragment 的 nets/ports 只能基于它们。
  //   此前是"纳入器件后把它全部 padNets 都算进来"——一颗因 SPI 被带入的 MCU，
  //   它的 USB_DP 也成了 DDS fragment 的端口，这是错的。
  const inFragment = new Map<string, FragmentComponent['role']>();
  inFragment.set(anchor.reference, 'ANCHOR');
  const traversedNets = new Set<number>();
  // 锚点自己的全部网络都是 fragment 的一部分（它是被分析的对象）
  for (const n of anchorNets) traversedNets.add(n);
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
          traversedNets.add(netId);        // 这条边真的走了
          next.push(pin.ref);
          // 被带入的**无源件**本身就是一条边（电容/电阻/晶振两端），它另一端的网络随之纳入
          //（去耦到 GND、滤波到 VOUT_FILT）。任何有源器件 —— 包括本地 LDO —— 只算真正走过的网络：
          // LDO 的输入轨、MCU 的 USB 接口都不是 DDS fragment 的接口。
          if (other.category === 'passive') {
            for (const n2 of Object.values(other.display?.padNets ?? {})) {
              if (Number.isFinite(n2) && n2 > 0) traversedNets.add(n2);
            }
          }
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  // fragment 涉及的 nets + 边界端口
  const nets: FragmentNet[] = [];
  const ports: FragmentPort[] = [];
  // 只基于实际遍历过的网络；不再把纳入器件的全部 padNets 都当成 fragment 网络
  const touched = traversedNets;
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

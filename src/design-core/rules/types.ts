/**
 * design-core/rules/types.ts
 * 放置规则配置模型 —— 规则数据化，不写死在算法里。
 */
import type { ComponentCategory } from '../document/types';

/**
 * 求解器真正实现的规则类型。生产规则（DEFAULT_PLACEMENT_RULES / AI / 用户规则）
 * 只允许使用这些。
 */
export type SupportedPlacementRuleType =
  | 'EDGE_ALIGN' // 靠板边
  | 'INSIDE_ZONE' // 在指定分区内
  | 'NEAR_COMPONENT'; // 靠近某类器件

/**
 * ⚠ 未实现的规则类型 —— 仅为旧数据兼容保留类型定义。
 * 求解器遇到这些类型会显式 console.warn 并按"无规则"处理（居中锚点），
 * 不会假装执行；等真正实现后再移入 Supported。
 */
export type UnsupportedPlacementRuleType = 'FAR_FROM_COMPONENT' | 'GROUP' | 'ORIENTATION';

export const SUPPORTED_PLACEMENT_RULE_TYPES: readonly SupportedPlacementRuleType[] = ['EDGE_ALIGN', 'INSIDE_ZONE', 'NEAR_COMPONENT'];

export type PlacementRuleType = SupportedPlacementRuleType | UnsupportedPlacementRuleType;

export type RuleSource = 'SYSTEM' | 'REFERENCE_DESIGN' | 'AI' | 'USER';

export type BoardEdge = 'left' | 'right' | 'top' | 'bottom';

export interface PlacementRule {
  id: string;
  /** 规则作用的器件类别 */
  appliesTo: ComponentCategory;
  type: PlacementRuleType;
  priority: number;
  source: RuleSource;
  params: {
    edge?: BoardEdge;
    edgeRatio?: number; // 沿边位置 0..1
    zoneId?: string; // INSIDE_ZONE
    nearCategory?: ComponentCategory; // NEAR_COMPONENT
    family?: string; // 进一步匹配 family（如 USB 贴左、Header 贴右）
  };
}

/** 默认系统规则集 —— 等价于 legacy 的 ZONES，但改为配置驱动。 */
export const DEFAULT_PLACEMENT_RULES: PlacementRule[] = [
  { id: 'r-usb-left', appliesTo: 'connector', type: 'EDGE_ALIGN', priority: 100, source: 'SYSTEM', params: { edge: 'left', edgeRatio: 0.3, family: 'USB' } },
  { id: 'r-header-right', appliesTo: 'connector', type: 'EDGE_ALIGN', priority: 90, source: 'SYSTEM', params: { edge: 'right', edgeRatio: 0.5, family: 'Header' } },
  { id: 'r-conn-bottom', appliesTo: 'connector', type: 'EDGE_ALIGN', priority: 50, source: 'SYSTEM', params: { edge: 'bottom', edgeRatio: 0.5 } },
  { id: 'r-power-tl', appliesTo: 'power', type: 'INSIDE_ZONE', priority: 80, source: 'SYSTEM', params: { zoneId: 'z-power' } },
  { id: 'r-mcu-center', appliesTo: 'mcu', type: 'INSIDE_ZONE', priority: 80, source: 'SYSTEM', params: { zoneId: 'z-mcu' } },
  { id: 'r-ic-right', appliesTo: 'ic', type: 'INSIDE_ZONE', priority: 70, source: 'SYSTEM', params: { zoneId: 'z-ic' } },
  { id: 'r-passive-near', appliesTo: 'passive', type: 'NEAR_COMPONENT', priority: 60, source: 'SYSTEM', params: { nearCategory: 'mcu' } },
];

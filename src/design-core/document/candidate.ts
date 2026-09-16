/**
 * design-core/document/candidate.ts
 * 器件候选（PartCandidate）—— 进入 Domain 的**输入 DTO**。
 *
 * 依赖方向修正：此前 design-core/document/services.ts 直接 import providers/types 的
 * ComponentSearchResult，Domain 反向依赖 Infrastructure。现在 Domain 自己定义这个形状，
 * providers/types 的 ComponentSearchResult 成为它的别名 —— 方向变成 Provider → Domain。
 *
 * 语义要求：候选**显式**携带来源（source），Domain 不再靠 componentId 前缀（ez_/sup_/ai_…）猜。
 * 未携带时才落到 legacy 推断（见 services.ts 的注释）。
 */
import type { ComponentCategory, Money, ComponentSource } from './types';

export interface OrganizationMaterialInfo {
  organizationId: string;
  materialId: string;
  internalPartNumber?: string;
  approved: boolean;
  stockQuantity?: number;
  preferred: boolean;
  lastPurchasePrice?: Money;
  projectUsageCount?: number;
}

export interface PartCandidate {
  componentId: string;
  mpn: string;
  manufacturer: string;
  category: ComponentCategory;
  defaultFootprintName: string;
  family: string;
  description: string;
  unitPrice?: Money;
  pins: number;
  attributes?: Record<string, string>;
  org?: OrganizationMaterialInfo;
  imageUrl?: string;
  productUrl?: string;
  datasheetUrl?: string;
  stepUrl?: string;
  footprintFileUrl?: string;
  symbolFileUrl?: string;
  classification?: string;
  coreParams?: Record<string, string>;
  /**
   * 显式来源。Provider 产出候选时必须填；缺失时 Domain 按 legacy 规则推断并视为过渡状态。
   */
  source?: ComponentSource;
}

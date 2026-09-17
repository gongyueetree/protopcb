/**
 * providers/types/index.ts
 * Provider 层接口契约。页面只依赖这些接口，不感知数据来自 Mock 还是 ezPLM。
 */
import type { ComponentCategory, Money } from '../../design-core/document/types';
import type { PartCandidate } from '../../design-core/document/candidate';
import type { FootprintGeometry } from '../../design-core/geometry/types';

/* ---------- 通用 ---------- */
/**
 * 调用方身份。**公开方法接受 null = 匿名**；不要用空字符串 userId 冒充匿名 ——
 * 那会让"有身份但为空"和"没有身份"无法区分，私有数据的判定全靠调用方自觉。
 */
/** 已登录的身份：私有数据路径只接受它 */
export type AuthenticatedAccessContext = AccessContext & { userId: string };

export interface AccessContext {
  userId: string;
  organizationId?: string;
  projectId?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/* ---------- 元器件 ---------- */
export interface ComponentSearchQuery {
  keyword?: string;
  category?: ComponentCategory;
  orgOnly?: boolean;
  page?: number;
  pageSize?: number;
}

import type { OrganizationMaterialInfo } from '../../design-core/document/candidate';
export type { OrganizationMaterialInfo };

/**
 * 检索结果的形状由 Domain 定义（design-core/document/candidate.ts）。
 * 这里只是别名：Provider 依赖 Domain，而不是反过来。
 */
export type ComponentSearchResult = PartCandidate;

/** 供应商报价（DigiKey/Mouser/Iceasy 等，来自 ezPLM 供应链 API） */
export interface SupplierOffer {
  vendor: string;
  price?: Money;
  stock?: number;
  url: string;
}

export interface FootprintOption {
  footprintId: string;
  name: string;
  geometry: FootprintGeometry;
  confidence: number;
  source: string; // KiCad 库来源
  category: string;
}

export interface ComponentAlternative {
  mpn: string;
  manufacturer: string;
  note: string;
  channel: string;
  footprint?: string;
  description?: string;
}

export interface PeripheralCircuitRecommendation {
  name: string;
  parts: string;
  why: string;
  /** 可一键加入画布的器件 componentId（若库中存在） */
  quickAddComponentId?: string;
}

export interface ComponentDataProvider {
  searchComponents(query: ComponentSearchQuery, ctx: AccessContext | null): Promise<Paginated<ComponentSearchResult>>;
  getComponentDetail(componentId: string, ctx: AccessContext | null): Promise<ComponentSearchResult | null>;
  getFootprintOptions(componentId: string, ctx: AccessContext | null): Promise<FootprintOption[]>;
  getAlternatives(componentId: string, ctx: AccessContext | null): Promise<ComponentAlternative[]>;
  getSupplierOffers(componentId: string, ctx: AccessContext | null): Promise<SupplierOffer[]>;
  getOrganizationContext(componentId: string, organizationId: string): Promise<OrganizationMaterialInfo | null>;
  /** 浏览全部封装（含分类） */
  listFootprints(category?: string): Promise<FootprintOption[]>;
}

/* ---------- 参考设计 / 子电路知识 ---------- */
export interface ReferenceDesignProvider {
  getRecommendedPeripheralCircuits(category: ComponentCategory, ctx: AccessContext | null): Promise<PeripheralCircuitRecommendation[]>;
  /**
   * 应用项目（组织内用过该器件的历史项目）—— 私有数据，必须带身份；
   * 匿名返回 UNAUTHORIZED，不发请求。
   */
  getApplicationProjects(componentId: string, mpn: string, ctx: AccessContext | null): Promise<ReferenceLoadResult>;
  /** 公开参考设计 —— 匿名可查 */
  getRelatedReferenceDesigns(componentId: string, mpn: string, ctx?: AccessContext | null): Promise<ReferenceLoadResult>;
}

/** 参考设计加载结果（与 reference-design/ezplm-provider 的 LoadResult 同构，放这里避免 UI 直连具体实现） */
export interface ReferenceLoadResult {
  state: 'IDLE' | 'LOADING' | 'READY' | 'ERROR' | 'BACKEND_NOT_CONNECTED' | 'UNAUTHORIZED';
  items: import('../reference-design/schema').ReferenceDesign[];
  detail?: string;
}

/* ---------- 身份 ---------- */


/* ---------- 项目（写回 ezPLM 的契约） ---------- */
export interface ProjectProvider {
  saveDesignDocument(projectId: string, docJson: string, ctx: AccessContext): Promise<{ ref: string }>;
  loadDesignDocument(projectId: string, ctx: AccessContext): Promise<string | null>;
}

/* ---------- AI ---------- */
export interface AiSchemeRequest {
  prompt: string;
  /**
   * 多轮修改：把上一版方案与用户的修改意见一起给模型，
   * 让它在既有方案上增删改，而不是每轮从零重画。
   */
  previous?: { summary?: string; components: { mpn: string; qty?: number; group?: string; core?: boolean; reason?: string }[] };
  feedback?: string;
}
/** 器件映射的显式验证结果：从 mapping 层传入，不允许按 componentId 前缀（ez_*）推断 */
export interface ComponentTrust {
  level: 'VERIFIED' | 'CANDIDATE' | 'PLACEHOLDER';
  evidence: string;
  source: 'ezplm-exact' | 'ezplm-candidate' | 'ai-only';
  verifiedAt: string;
  /** CANDIDATE 时：数据库中最接近的候选（仅供用户确认，不自动替换） */
  candidate?: { componentId: string; mpn: string; manufacturer?: string };
}

export interface AiSchemeResult {
  componentIds: string[];
  rationale: string;
  /** Gemini 真实链路：完整器件对象（含 ezPLM 映射来源），存在时优先于 componentIds */
  items?: (ComponentSearchResult & { mapSource?: string; trust?: ComponentTrust; group?: string; core?: boolean; qty?: number })[];
  /** 方案框图（块 + 块间连接） */
  blocks?: { id: string; label: string; core?: string; kind: string }[];
  blockLinks?: { from: string; to: string; label?: string; kind: string }[];
  /** 结果来源与回退原因（UI 数据源徽标用） */
  source?: 'gemini' | 'mock';
  fallbackReason?: string;
}
export interface AiModelProvider {
  /** AI 能力必须已登录：类型上就只接受已认证身份，避免匿名调用靠空 userId 混过去 */
  generateScheme(req: AiSchemeRequest, ctx: AuthenticatedAccessContext): Promise<AiSchemeResult>;
}

/* ---------- Provider 集合 ---------- */
export interface ProviderRegistry {
  components: ComponentDataProvider;
  referenceDesigns: ReferenceDesignProvider;
  project: ProjectProvider;
  ai: AiModelProvider;
}

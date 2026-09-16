/**
 * providers/ezplm/index.ts
 * ezPLM Provider 实现 —— 通过 HttpClient 调用 ezPLM 后端，DTO 经 mappers 归一化。
 *
 * 几何兜底：若组件详情未带真实封装几何，用 fallbackFootprint 按封装名估算，
 * 保证画布碰撞/面积仍可工作。
 */
import { EzplmReferenceDesignProvider as RefDesignImpl } from '../reference-design/ezplm-provider';
import type {
  ComponentDataProvider, ReferenceDesignProvider, IdentityProvider, ProjectProvider,
  ComponentSearchQuery, AccessContext, Paginated, ComponentSearchResult, FootprintOption,
  ComponentAlternative, OrganizationMaterialInfo, PeripheralCircuitRecommendation, CurrentUser,
} from '../types';
import type { ComponentCategory } from '../../design-core/document/types';
import { HttpClient } from '../http/client';
import { searchEzplmParts, isEzplmPart } from './live';
import type { EzplmMeDto, EzplmPeripheralCircuitDto } from './contracts';
import { mapPeripheralCircuit, fallbackFootprint } from './mappers';

export class EzplmComponentDataProvider implements ComponentDataProvider {
  constructor(private http: HttpClient) {}

  /**
   * 系统库检索：委托真实的 /api/ezplm 客户端（live.ts）。
   * 本组织物料（orgOnly）需要 ezPLM 的组织级端点 —— 尚未提供，明确返回空并标 NOT_CONNECTED，
   * 不再去打从未存在的 /v1/components/search。
   */
  async searchComponents(query: ComponentSearchQuery, _ctx: AccessContext): Promise<Paginated<ComponentSearchResult>> {
    const pageSize = query.pageSize ?? 30;
    if (query.orgOnly) {
      return { items: [], total: 0, page: 1, pageSize, notConnected: 'ORGANIZATION_MATERIALS_NOT_CONNECTED' } as Paginated<ComponentSearchResult> & { notConnected: string };
    }
    const r = await searchEzplmParts(query.keyword ?? '', pageSize);
    const items = query.category ? r.items.filter((i) => i.category === query.category) : r.items;
    return { items, total: items.length, page: 1, pageSize };
  }

  /** 单件详情：真实接口没有 by-id 端点；用型号做一次精确检索代替 */
  async getComponentDetail(componentId: string): Promise<ComponentSearchResult | null> {
    if (!isEzplmPart(componentId)) return null;
    const mpn = componentId.replace(/^ez_/, '');
    const r = await searchEzplmParts(mpn, 5).catch(() => ({ available: false, items: [] as ComponentSearchResult[] }));
    return r.items.find((i) => i.componentId === componentId) ?? r.items[0] ?? null;
  }

  /**
   * 以下四个能力 ezPLM 开放接口尚未提供（API-Key 手册只有 parts / reference-designs 两个只读端点）。
   * 此前指向从未存在的 /v1/components/{id}/... 路径，请求必然 404 再被吞成空数组 ——
   * 现在不发请求，直接返回空并把 NOT_CONNECTED 原因挂在 provider 上，UI 可如实展示。
   */
  readonly notConnected = {
    footprintOptions: 'FOOTPRINT_OPTIONS_NOT_CONNECTED',
    supplierOffers: 'EZPLM_SUPPLIER_OFFERS_NOT_CONNECTED',
    alternatives: 'ALTERNATIVES_NOT_CONNECTED',
    organizationContext: 'ORGANIZATION_MATERIALS_NOT_CONNECTED',
  } as const;

  async getFootprintOptions(): Promise<FootprintOption[]> {
    return [];
  }

  async getSupplierOffers() {
    return [] as { vendor: string; price?: { amount: number; currency: string }; stock?: number; url: string }[];
  }

  async getAlternatives(): Promise<ComponentAlternative[]> {
    return [];
  }

  async getOrganizationContext(): Promise<OrganizationMaterialInfo | null> {
    return null;
  }

  /** /v1/footprints 同样不存在；封装列表由 KiCad 官方库（application/library）提供 */
  async listFootprints(): Promise<FootprintOption[]> {
    return [];
  }

  /** 详情若缺几何，用此方法补一个兜底封装（供放置引擎使用）。 */
  resolveFootprintGeometry(footprintName: string): FootprintOption {
    return fallbackFootprint(footprintName);
  }
}

export class EzplmReferenceDesignProvider implements ReferenceDesignProvider {
  constructor(private http: HttpClient) {}
  async getRecommendedPeripheralCircuits(category: ComponentCategory): Promise<PeripheralCircuitRecommendation[]> {
    const dtos = await this.http.get<EzplmPeripheralCircuitDto[]>('/v1/reference-designs/peripheral-circuits', { category });
    return (dtos ?? []).map(mapPeripheralCircuit);
  }
  // 参考设计 / 应用项目：委托给统一的 reference-design 模块（带租户缓存与身份判定）
  getApplicationProjects(componentId: string, mpn: string, ctx: AccessContext | null) {
    return RefDesignImpl.getApplicationProjects(componentId, mpn, ctx);
  }
  getRelatedReferenceDesigns(componentId: string, mpn: string) {
    return RefDesignImpl.getRelatedReferenceDesigns(componentId, mpn);
  }
}

export class EzplmIdentityProvider implements IdentityProvider {
  constructor(private http: HttpClient) {}
  async getCurrentUser(): Promise<CurrentUser> {
    const dto = await this.http.get<EzplmMeDto>('/v1/me');
    return { userId: dto.user_id, displayName: dto.display_name, organizationId: dto.organization_id };
  }
  async getAccessContext(): Promise<AccessContext> {
    const u = await this.getCurrentUser();
    return { userId: u.userId, organizationId: u.organizationId };
  }
}

/** 云端设计存储尚未接通时抛出的错误：UI 据此显示"未接通"，不做假成功 */
export class CloudProjectNotConnectedError extends Error {
  readonly code = 'CLOUD_PROJECT_API_NOT_CONNECTED';
  constructor() { super('云端设计存储（Cloud Project API）尚未接通，设计只保存在本浏览器'); this.name = 'CloudProjectNotConnectedError'; }
}

/**
 * ezPLM 云端项目存储 —— **NOT_CONNECTED**。
 * /v1/projects/{id}/design 是设想中的契约，后端未提供。此前 load 会把 404 吞成 null、
 * save 会抛一个"HTTP 404"，UI 无法区分"没有存档"和"没有后端"。现在明确抛 NOT_CONNECTED。
 */
export class EzplmProjectProvider implements ProjectProvider {
  constructor(private http: HttpClient) { void this.http; }
  async saveDesignDocument(): Promise<{ ref: string }> {
    throw new CloudProjectNotConnectedError();
  }
  async loadDesignDocument(): Promise<string | null> {
    throw new CloudProjectNotConnectedError();
  }
}

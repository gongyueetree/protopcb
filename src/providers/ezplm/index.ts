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
import type {
  EzplmMeDto, EzplmComponentDto, EzplmPagedDto, EzplmFootprintDto,
  EzplmAlternativeDto, EzplmOrgMaterialDto, EzplmPeripheralCircuitDto,
} from './contracts';
import {
  mapComponent, mapFootprint, mapAlternative, mapOrgMaterial, mapPeripheralCircuit, fallbackFootprint,
} from './mappers';

export class EzplmComponentDataProvider implements ComponentDataProvider {
  constructor(private http: HttpClient) {}

  async searchComponents(query: ComponentSearchQuery, _ctx: AccessContext): Promise<Paginated<ComponentSearchResult>> {
    const dto = await this.http.get<EzplmPagedDto<EzplmComponentDto>>('/v1/components/search', {
      keyword: query.keyword,
      category: query.category,
      orgOnly: query.orgOnly,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 30,
    });
    return { items: dto.items.map(mapComponent), total: dto.total, page: dto.page, pageSize: dto.page_size };
  }

  async getComponentDetail(componentId: string): Promise<ComponentSearchResult | null> {
    try {
      const dto = await this.http.get<EzplmComponentDto>(`/v1/components/${encodeURIComponent(componentId)}`);
      return mapComponent(dto);
    } catch {
      return null;
    }
  }

  async getFootprintOptions(componentId: string): Promise<FootprintOption[]> {
    const dtos = await this.http.get<EzplmFootprintDto[]>(`/v1/components/${encodeURIComponent(componentId)}/footprints`);
    if (!dtos || dtos.length === 0) return [];
    return dtos.map(mapFootprint);
  }

  async getSupplierOffers(componentId: string) {
    const dtos = await this.http.get<{ vendor: string; price?: { amount: number; currency: string }; stock?: number; url: string }[]>(`/v1/components/${encodeURIComponent(componentId)}/suppliers`);
    return dtos ?? [];
  }

  async getAlternatives(componentId: string): Promise<ComponentAlternative[]> {
    const dtos = await this.http.get<EzplmAlternativeDto[]>(`/v1/components/${encodeURIComponent(componentId)}/alternatives`);
    return (dtos ?? []).map(mapAlternative);
  }

  async getOrganizationContext(componentId: string, organizationId: string): Promise<OrganizationMaterialInfo | null> {
    try {
      const dto = await this.http.get<EzplmOrgMaterialDto>(
        `/v1/organizations/${encodeURIComponent(organizationId)}/materials/${encodeURIComponent(componentId)}`
      );
      return mapOrgMaterial(dto) ?? null;
    } catch {
      return null;
    }
  }

  async listFootprints(category?: string): Promise<FootprintOption[]> {
    const dtos = await this.http.get<EzplmFootprintDto[]>('/v1/footprints', { category });
    return (dtos ?? []).map(mapFootprint);
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

export class EzplmProjectProvider implements ProjectProvider {
  constructor(private http: HttpClient) {}
  async saveDesignDocument(projectId: string, docJson: string): Promise<{ ref: string }> {
    const res = await this.http.put<{ ref: string }>(`/v1/projects/${encodeURIComponent(projectId)}/design`, JSON.parse(docJson));
    return res;
  }
  async loadDesignDocument(projectId: string): Promise<string | null> {
    try {
      const doc = await this.http.get<unknown>(`/v1/projects/${encodeURIComponent(projectId)}/design`);
      return doc ? JSON.stringify(doc) : null;
    } catch {
      return null;
    }
  }
}

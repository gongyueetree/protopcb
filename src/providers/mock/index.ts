/**
 * providers/mock/index.ts
 * Mock Provider 实现 —— 用内存数据满足全部 Provider 契约。
 * 异步签名与真实接口一致，便于将来无缝替换为 EzplmProvider。
 */
import type {
  ComponentDataProvider, ReferenceDesignProvider, IdentityProvider, ProjectProvider, AiModelProvider,
  ComponentSearchQuery, AccessContext, Paginated, ComponentSearchResult, FootprintOption,
  ComponentAlternative, OrganizationMaterialInfo, PeripheralCircuitRecommendation,
  CurrentUser, AiSchemeRequest, AiSchemeResult,
} from '../types';
import type { ComponentCategory } from '../../design-core/document/types';
import { MOCK_COMPONENTS, LEGACY_PARTS, FOOTPRINT_LIBRARY, ALTERNATIVES, SUBCIRCUITS, geometryFor, supplierOffersFor } from './data';

/** id 查找并集：常用件 + 旧演示目录（AI演示方案/详情兼容） */
const ALL_PARTS = [...MOCK_COMPONENTS, ...LEGACY_PARTS];

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));

export class MockComponentDataProvider implements ComponentDataProvider {
  async searchComponents(query: ComponentSearchQuery, _ctx: AccessContext): Promise<Paginated<ComponentSearchResult>> {
    await delay();
    let items = [...MOCK_COMPONENTS];
    if (query.orgOnly) items = items.filter((c) => c.isOrg);
    if (query.category) items = items.filter((c) => c.category === query.category);
    if (query.keyword?.trim()) {
      const q = query.keyword.toLowerCase();
      items = items.filter((c) =>
        c.mpn.toLowerCase().includes(q) || c.defaultFootprintName.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) || c.family.toLowerCase().includes(q) ||
        c.manufacturer.toLowerCase().includes(q)
      );
    }
    items.sort((a, b) => (b.isOrg ? 1 : 0) - (a.isOrg ? 1 : 0));
    const enriched = items.map((c) => ({ ...c, org: c.isOrg ? this.makeOrg(c.componentId) : undefined }));
    return { items: enriched, total: enriched.length, page: 1, pageSize: enriched.length };
  }

  async getComponentDetail(componentId: string): Promise<ComponentSearchResult | null> {
    await delay(60);
    const c = ALL_PARTS.find((x) => x.componentId === componentId);
    return c ? { ...c, org: c.isOrg ? this.makeOrg(c.componentId) : undefined } : null;
  }

  async getFootprintOptions(componentId: string): Promise<FootprintOption[]> {
    await delay(60);
    const c = ALL_PARTS.find((x) => x.componentId === componentId);
    if (!c) return [];
    return [{ footprintId: c.defaultFootprintName, name: c.defaultFootprintName, geometry: geometryFor(c.defaultFootprintName), confidence: 1, source: 'KiCad', category: c.category }];
  }

  async getAlternatives(componentId: string): Promise<ComponentAlternative[]> {
    await delay(60);
    const c = ALL_PARTS.find((x) => x.componentId === componentId);
    return c ? ALTERNATIVES[c.mpn] ?? [] : [];
  }

  async getSupplierOffers(componentId: string) {
    await delay(80);
    const c = ALL_PARTS.find((x) => x.componentId === componentId);
    return c ? supplierOffersFor(c.mpn, c.unitPrice?.amount ?? 1) : [];
  }

  async getOrganizationContext(componentId: string, organizationId: string): Promise<OrganizationMaterialInfo | null> {
    const c = ALL_PARTS.find((x) => x.componentId === componentId);
    return c?.isOrg ? this.makeOrg(componentId, organizationId) : null;
  }

  async listFootprints(category?: string): Promise<FootprintOption[]> {
    await delay(80);
    return category ? FOOTPRINT_LIBRARY.filter((f) => f.category === category) : FOOTPRINT_LIBRARY;
  }

  private makeOrg(materialId: string, organizationId = 'org-demo'): OrganizationMaterialInfo {
    return { organizationId, materialId, internalPartNumber: `INT-${materialId.toUpperCase()}`, approved: true, preferred: true, stockQuantity: 500, projectUsageCount: 3 };
  }
}

export class MockReferenceDesignProvider implements ReferenceDesignProvider {
  async getRecommendedPeripheralCircuits(category: ComponentCategory): Promise<PeripheralCircuitRecommendation[]> {
    await delay(60);
    return SUBCIRCUITS[category] ?? [];
  }
}

export class MockIdentityProvider implements IdentityProvider {
  async getCurrentUser(): Promise<CurrentUser> {
    return { userId: 'demo-user', displayName: '演示用户', organizationId: 'org-demo' };
  }
  async getAccessContext(): Promise<AccessContext> {
    return { userId: 'demo-user', organizationId: 'org-demo' };
  }
}

export class LocalStorageProjectProvider implements ProjectProvider {
  private key(projectId: string) { return `cc:design:${projectId}`; }
  async saveDesignDocument(projectId: string, docJson: string): Promise<{ ref: string }> {
    try { localStorage.setItem(this.key(projectId), docJson); } catch { /* ignore */ }
    return { ref: this.key(projectId) };
  }
  async loadDesignDocument(projectId: string): Promise<string | null> {
    try { return localStorage.getItem(this.key(projectId)); } catch { return null; }
  }
}

export class MockAiModelProvider implements AiModelProvider {
  async generateScheme(req: AiSchemeRequest): Promise<AiSchemeResult> {
    await delay(700);
    const q = req.prompt.toLowerCase();
    const picks: string[] = [];
    const add = (id: string) => { if (!picks.includes(id)) picks.push(id); };
    if (q.includes('wifi') || q.includes('蓝牙') || q.includes('物联') || q.includes('iot') || q.includes('esp')) add('esp32s3');
    else if (q.includes('高性能') || q.includes('f4') || q.includes('图像')) add('stm32f407');
    else add('stm32f103');
    add('lm1117');
    if (q.includes('12v') || q.includes('24v') || q.includes('宽压') || q.includes('车')) add('tps5430');
    if (q.includes('usb') || q.includes('串口') || q.includes('上位机') || q.includes('调试')) { add('usbc'); add('ch340'); }
    else add('header2x5');
    if (q.includes('can')) add('tja1050');
    if (q.includes('存储') || q.includes('flash') || q.includes('记录')) add('w25q64');
    add('cap100nf'); add('res10k');
    return { componentIds: picks, rationale: `根据需求"${req.prompt}"选型：主控+电源+接口+去耦组合，已按电气规则布局。` };
  }
}

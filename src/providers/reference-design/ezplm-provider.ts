/**
 * providers/reference-design/ezplm-provider.ts
 * EzplmReferenceDesignProvider —— HTTP 只在 Provider 层，不散落 React 组件（方案 §四十六）。
 *
 * 两条数据线，来源类别严格区分（方案 §四）：
 *
 * 1) getRelatedReferenceDesigns(componentId)
 *    走已上线的 /api/ezplm?path=reference-designs（真实 ezPLM 端点，服务端签名代理），
 *    把旧的 {name, link, image, description} 响应映射进统一 ReferenceDesign 模型。
 *    sourceType/资产标记由链接与文本推断，verification 一律 EXTRACTED（低置信），
 *    绝不因"来自 ezPLM 搜索"就标 VERIFIED。
 *
 * 2) getApplicationProjects(mpn|componentId)
 *    ezPLM 网页端存在"应用项目"页面，但 API-Key 开放接口目前【未确认】有对应端点。
 *    本 Provider 按方案 §六 的 contract 实现完整调用与解析；服务端代理已放行
 *    application-projects 路径。上游 404/501 → 返回 BACKEND_NOT_CONNECTED，
 *    UI 如实显示，禁止硬编码假项目冒充。
 *
 * 权限（方案 §四十二/四十四）：应用项目是私有数据，响应缓存按 componentId 仅存于
 * 本会话内存（页面刷新即失效），不写 localStorage，不与公共参考设计混存。
 */
import { z } from 'zod';
import {
  type ReferenceDesign, type ReferenceLoadState, ReferenceDesignSchema, NO_ASSETS,
} from './schema';
import { isEzplmPart } from '../ezplm-live';
import { getPrivate, setPrivate } from './private-cache';
import type { AccessContext } from '../types';

const EZ_PREFIX = 'ez_';

export interface LoadResult<T> {
  state: ReferenceLoadState;
  items: T[];
  /** state=ERROR/BACKEND_NOT_CONNECTED 时的人话说明 */
  detail?: string;
}

/* ---------------- 相关参考设计（真实端点） ---------------- */

const LegacyRefSchema = z.object({
  name: z.string().optional(),
  link: z.string().optional(),
  url: z.string().optional(),
  image: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

/** 由链接/标题推断来源类别（保守：推不出就 OTHER_PUBLIC） */
export function inferSourceType(link: string | undefined, title: string): ReferenceDesign['sourceType'] {
  const l = (link ?? '').toLowerCase();
  const t = title.toLowerCase();
  if (l.includes('github.com')) return 'KICAD_PROJECT' === classifyRepo(l, t) ? 'KICAD_PROJECT' : 'GITHUB';
  if (l.includes('tindie.com')) return 'TINDIE';
  if (l.includes('seeedstudio.com') || l.includes('seeed')) return 'SEEED';
  if (l.includes('hackster.io')) return 'HACKSTER';
  if (l.includes('hackaday')) return 'HACKADAY';
  if (/eval|评估板|evaluation/.test(t)) return 'EVALUATION_BOARD';
  if (/analog\.com|ti\.com|st\.com|nxp\.com|microchip\.com|infineon\.com|renesas\.com|onsemi\.com/.test(l)) return 'VENDOR_REFERENCE';
  if (/reference design|参考设计/.test(t)) return 'VENDOR_REFERENCE';
  if (l.endsWith('.pdf')) return 'PDF_SCHEMATIC';
  if (/datasheet|typical application/.test(t)) return 'DATASHEET_APPLICATION';
  return 'OTHER_PUBLIC';
}
function classifyRepo(link: string, title: string): 'KICAD_PROJECT' | 'GITHUB' {
  return /kicad/.test(link) || /kicad/.test(title) ? 'KICAD_PROJECT' : 'GITHUB';
}

/** 旧响应 → 统一模型（导出以便单测） */
export function mapLegacyReference(raw: unknown, idx: number, anchorMpn: string): ReferenceDesign | null {
  const p = LegacyRefSchema.safeParse(raw);
  if (!p.success) return null;
  const title = (p.data.name ?? '').trim() || '参考设计';
  const link = (p.data.link ?? p.data.url ?? '').trim() || undefined;
  const sourceType = inferSourceType(link, title);
  const isPdf = !!link && /\.pdf(\?|$)/i.test(link);
  const candidate = {
    id: `ezrd_${idx}_${title.slice(0, 24)}`,
    title,
    sourceType,
    sourceSystem: sourceType === 'GITHUB' || sourceType === 'KICAD_PROJECT' ? 'GITHUB' as const
      : sourceType === 'VENDOR_REFERENCE' || sourceType === 'EVALUATION_BOARD' || sourceType === 'DATASHEET_APPLICATION' ? 'VENDOR' as const
      : 'PUBLIC' as const,
    ownerType: 'PUBLIC' as const,
    sourceUrl: link && /^https?:\/\//.test(link) ? link : undefined,
    imageUrl: p.data.image && /^https?:\/\//.test(p.data.image) ? p.data.image : undefined,
    description: p.data.description?.slice(0, 1000),
    anchorMpns: [anchorMpn],
    availableAssets: {
      ...NO_ASSETS,
      pdf: isPdf,
      // KiCad 仓库大概率有 sch/pcb；其余不臆断
      schematic: sourceType === 'KICAD_PROJECT',
      pcb: sourceType === 'KICAD_PROJECT',
    },
    verification: {
      // 来自 ezPLM 聚合搜索 ≠ 已验证：一律 EXTRACTED 低置信；厂商官方来源给 VENDOR_REFERENCE
      level: (sourceType === 'VENDOR_REFERENCE' || sourceType === 'EVALUATION_BOARD' ? 'VENDOR_REFERENCE' : 'EXTRACTED') as ReferenceDesign['verification']['level'],
      confidence: sourceType === 'VENDOR_REFERENCE' || sourceType === 'EVALUATION_BOARD' ? 0.6 : 0.3,
      evidence: [{ kind: 'api', detail: 'ezPLM reference-designs 聚合搜索结果' }],
    },
  };
  const r = ReferenceDesignSchema.safeParse(candidate);
  return r.success ? r.data : null;
}

/* ---------------- 应用项目（contract 就绪，等待后端端点确认） ---------------- */

const AppProjectRawSchema = z.object({
  projectId: z.union([z.string(), z.number()]).optional(),
  projectName: z.string().optional(),
  name: z.string().optional(),
  bomId: z.union([z.string(), z.number()]).optional(),
  version: z.string().optional(),
  quantity: z.number().optional(),
  hasSchematic: z.boolean().optional(),
  hasPcb: z.boolean().optional(),
  hasBom: z.boolean().optional(),
  hasPdf: z.boolean().optional(),
  lastUsedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  verification: z.object({ level: z.string().optional() }).optional(),
}).passthrough();

/** 应用项目原始记录 → 统一模型（导出以便单测/未来后端联调） */
export function mapApplicationProject(raw: unknown, anchorMpn: string): ReferenceDesign | null {
  const p = AppProjectRawSchema.safeParse(raw);
  if (!p.success) return null;
  const d = p.data;
  const title = (d.projectName ?? d.name ?? '').trim();
  if (!title) return null;
  const levelRaw = d.verification?.level ?? '';
  const level: ReferenceDesign['verification']['level'] =
    levelRaw === 'PRODUCTION_VERIFIED' ? 'PRODUCTION_VERIFIED'
    : levelRaw === 'PROTOTYPE_VERIFIED' ? 'PROTOTYPE_VERIFIED'
    : levelRaw === 'SIMULATION_VERIFIED' ? 'SIMULATION_VERIFIED'
    : 'EXTRACTED';   // 未标注验证等级的历史项目不冒充"实测"
  const candidate = {
    id: `ezap_${String(d.projectId ?? title).slice(0, 60)}`,
    title,
    sourceType: 'EZPLM_PROJECT' as const,
    sourceSystem: 'EZPLM' as const,
    ownerType: 'ORGANIZATION' as const,
    projectId: d.projectId != null ? String(d.projectId) : undefined,
    projectVersion: d.version,
    bomId: d.bomId != null ? String(d.bomId) : undefined,
    anchorMpns: [anchorMpn],
    anchorQuantity: Number.isFinite(d.quantity) && (d.quantity as number) > 0 ? d.quantity : undefined,
    availableAssets: {
      ...NO_ASSETS,
      schematic: d.hasSchematic ?? false,
      pcb: d.hasPcb ?? false,
      bom: d.hasBom ?? false,
      pdf: d.hasPdf ?? false,
    },
    verification: {
      level,
      confidence: level === 'PRODUCTION_VERIFIED' ? 0.95 : level === 'PROTOTYPE_VERIFIED' ? 0.85 : 0.5,
      evidence: [{ kind: 'api', detail: 'ezPLM 应用项目（私有数据，仅本会话缓存）' }],
    },
    lastUsedAt: d.lastUsedAt ?? d.updatedAt,
  };
  const r = ReferenceDesignSchema.safeParse(candidate);
  return r.success ? r.data : null;
}

/* ---------------- Provider ---------------- */

/** 私有数据缓存：内存 Map，仅本会话（方案 §四十四：私有数据禁止跨用户/持久缓存） */
const relatedCache = new Map<string, LoadResult<ReferenceDesign>>();

export const EzplmReferenceDesignProvider = {
  /**
   * 应用项目：当前用户/组织历史项目中使用过该器件的项目 —— **私有数据**。
   * 必须带身份：匿名直接返回 UNAUTHORIZED，不发请求；缓存键含租户与用户，切账号不串。
   */
  async getApplicationProjects(componentId: string, mpn: string, ctx?: AccessContext | null): Promise<LoadResult<ReferenceDesign>> {
    if (!isEzplmPart(componentId)) return { state: 'IDLE', items: [] };
    if (!ctx?.userId) return { state: 'UNAUTHORIZED', items: [], detail: '应用项目是私有数据，登录后可见' };
    const key = { tenantId: ctx.organizationId ?? '', userId: ctx.userId, resourceId: `app-projects:${componentId}` };
    const hit = getPrivate<LoadResult<ReferenceDesign>>(key);
    if (hit) return hit;
    const partlibId = componentId.slice(EZ_PREFIX.length);
    let out: LoadResult<ReferenceDesign>;
    try {
      // 带上用户会话：服务端必须以用户身份而不是全局 Key 去取私有项目
      const r = await fetch(`/api/ezplm?path=application-projects&partlibId=${encodeURIComponent(partlibId)}&mpn=${encodeURIComponent(mpn)}&pageSize=20`, { credentials: 'include' });
      if (r.status === 404 || r.status === 501) {
        out = { state: 'BACKEND_NOT_CONNECTED', items: [], detail: 'ezPLM 开放接口暂未提供"应用项目"端点（网页端已有此数据；待后端开通后此处自动接通）' };
      } else if (r.status === 401 || r.status === 403) {
        out = { state: 'UNAUTHORIZED', items: [], detail: '当前 API Key 无权访问应用项目数据' };
      } else if (!r.ok) {
        out = { state: 'ERROR', items: [], detail: `ezPLM 返回 HTTP ${r.status}` };
      } else {
        const j = await r.json();
        const rawList: unknown[] = Array.isArray(j?.projects) ? j.projects : Array.isArray(j?.data) ? j.data : [];
        const items = rawList.map((x) => mapApplicationProject(x, mpn)).filter((x): x is ReferenceDesign => !!x);
        out = { state: 'READY', items };
      }
    } catch {
      out = { state: 'ERROR', items: [], detail: '网络异常' };
    }
    // BACKEND_NOT_CONNECTED / READY 缓存本会话；瞬时错误不缓存以便重试
    if (out.state === 'READY' || out.state === 'BACKEND_NOT_CONNECTED') setPrivate(key, out);
    return out;
  },

  /** 相关参考设计：公开来源（真实端点已上线） */
  async getRelatedReferenceDesigns(componentId: string, mpn: string): Promise<LoadResult<ReferenceDesign>> {
    if (!isEzplmPart(componentId)) return { state: 'IDLE', items: [] };
    const hit = relatedCache.get(componentId);
    if (hit) return hit;
    const partlibId = componentId.slice(EZ_PREFIX.length);
    let out: LoadResult<ReferenceDesign>;
    try {
      const r = await fetch(`/api/ezplm?path=reference-designs&partlibId=${encodeURIComponent(partlibId)}&pageSize=20`);
      if (!r.ok) {
        // 手册 §3「常见情况」：404 = partlibId 无效或物料不存在（等同没有参考设计）；
        // 429 = 当天调用次数已达上限（不是错误配置，要让用户看懂）；501 = 本地未配 Key
        out = r.status === 404
          ? { state: 'READY', items: [] }
          : {
              state: r.status === 501 ? 'BACKEND_NOT_CONNECTED' : 'ERROR',
              items: [],
              detail: r.status === 429 ? 'ezPLM 当天调用次数已达上限，请次日再试或联系管理员重置'
                : r.status === 401 || r.status === 400 ? `ezPLM 鉴权失败（HTTP ${r.status}）：请检查 EZPLM_API_KEY 是否有效`
                : `ezPLM 返回 HTTP ${r.status}`,
            };
      } else {
        const j = await r.json();
        const rawList: unknown[] = Array.isArray(j?.data) ? j.data : [];
        const items = rawList.map((x, i) => mapLegacyReference(x, i, mpn)).filter((x): x is ReferenceDesign => !!x);
        out = { state: 'READY', items };
      }
    } catch {
      out = { state: 'ERROR', items: [], detail: '网络异常' };
    }
    if (out.state === 'READY') relatedCache.set(componentId, out);
    return out;
  },
};

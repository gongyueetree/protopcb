/**
 * providers/gemini/index.ts — Gemini 大模型（经 /api/gemini 服务端代理）
 *
 * Key 在 Vercel 环境变量 GEMINI_API_KEY（服务端专用），前端只调自己的代理。
 *
 * generateScheme 真实链路：
 *   Gemini 生成器件清单(JSON) → 逐个经 ezPLM parts API 映射：
 *   命中 → 用 ezPLM 云端器件（真实封装/符号/STEP 文件链接随行）
 *   未命中（典型为无源件/连接器）→ 按 Gemini 建议的封装名做封装占位，交用户确认
 */
import type { AiModelProvider, AiSchemeRequest, AiSchemeResult, AccessContext, ComponentSearchResult, ComponentTrust } from '../types';
import { searchEzplmParts, ezplmLiveAvailable } from '../ezplm-live';
import type { ComponentCategory } from '../../design-core/document/types';
import { AiSchemeSchema, validateAi, assessTrust, type AiComponent } from '../ai-schema';
import { aiRequest } from '../ai-client';
import { kicadPassiveDefaults } from '../../design-core/geometry/kicad-passive-defaults';

/* ---------- 可用性与通用补全（代理） ---------- */
let availableCache: boolean | null = null;

export async function geminiAvailable(): Promise<boolean> {
  if (availableCache !== null) return availableCache;
  try {
    const r = await fetch('/api/gemini?path=status');
    availableCache = !!(await r.json()).configured;
  } catch {
    availableCache = false;
  }
  return availableCache;
}

/** 一次性文本补全（经服务端代理） */
/**
 * @deprecated 统一入口已改为 providers/ai-client 的 aiRequest()。
 * 保留 re-export 仅为兼容旧导入；业务代码不得再拼 prompt 调用它。
 */
export { AiAccessError } from '../ai-client';

/** 从模型输出中稳健提取 JSON（剥离 ```json 围栏与前后杂文） */
export function extractJson<T>(text: string): T {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const starts = ['{', '['].map((ch) => cleaned.indexOf(ch)).filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start < 0 || end < 0) throw new Error('模型未返回 JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

/* ---------- 真实方案生成 ---------- */

const CAT_MAP: Record<string, ComponentCategory> = { mcu: 'mcu', power: 'power', passive: 'passive', connector: 'connector', ic: 'ic', sensor: 'ic', rf: 'ic', electromech: 'connector', other: 'ic' };

/** 型号规范化：仅字母数字大写比较（用于 exact match 判定） */
const normMpn = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class GeminiAiProvider implements AiModelProvider {
  async generateScheme(req: AiSchemeRequest, _ctx: AccessContext): Promise<AiSchemeResult> {
    // prompt 已移到服务端注册表（api/_lib/ai-operations.js）；客户端只发结构化输入。
    // 多轮修改走 scheme.revise（3 Credit），首轮走 scheme.generate（5 Credit）——
    // 此前修改轮也按 generate 计费，多扣了用户 2 Credit。
    // 延迟导入：i18n 模块初始化会碰 localStorage，静态导入会让纯 Node 测试挂掉
    const lang = (await import('../../shared/i18n')).useLangStore.getState().lang;
    const isRevise = !!(req.previous && req.feedback);
    const { text } = isRevise
      ? await aiRequest('scheme.revise', {
          requirement: req.prompt, feedback: req.feedback,
          previous: { summary: req.previous!.summary, components: req.previous!.components.map((c) => ({ mpn: c.mpn, qty: c.qty, group: c.group, core: c.core, reason: c.reason })) },
          lang,
        })
      : await aiRequest('scheme.generate', { requirement: req.prompt, lang });
    // ── 主链路：extractJson → Zod(AiSchemeSchema) → 语义校验 → DB 验证 → trust ──
    // 任何未通过 schema 校验的 Gemini 输出整条拒绝，绝不"尽力解析一部分"进 store。
    let raw: unknown;
    try {
      raw = extractJson<unknown>(text);
    } catch (e) {
      throw new Error(`模型输出无法解析为 JSON：${String((e as Error).message ?? e)}`);
    }
    // 兼容模型偶发使用旧字段名（rationale/role）——仅做字段名映射，不放宽校验
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      if (o.rationale && !o.summary) o.summary = o.rationale;
      if (Array.isArray(o.components)) {
        for (const c of o.components as Record<string, unknown>[]) {
          if (c && typeof c === 'object' && c.role && !c.reason) c.reason = c.role;
        }
      }
    }
    const checked = validateAi(AiSchemeSchema, raw, 'AI 方案');
    if (!checked.ok || !checked.data) throw new Error(checked.error ?? 'AI 方案校验失败');
    const comps = checked.data.components.slice(0, 12) as AiComponent[];

    const liveOk = await ezplmLiveAvailable();
    const items: NonNullable<AiSchemeResult['items']> = [];
    const now = () => new Date().toISOString();
    for (const sc of comps) {
      const qty = Math.max(1, Math.min(8, sc.qty ?? 1));
      let mapped: (ComponentSearchResult & { mapSource?: string; trust?: ComponentTrust; group?: string; core?: boolean; qty?: number }) | null = null;
      let candidateHit: ComponentSearchResult | undefined;
      if (liveOk && sc.mpn) {
        const live = await searchEzplmParts(sc.mpn, 5).catch(() => ({ available: false, items: [] as ComponentSearchResult[] }));
        // VERIFIED 仅允许规范化后 exact match。
        // 此前的 startsWith 双向前缀匹配已删除：型号后缀承载封装/容量/温度等级/电压等
        // 关键差异（STM32F103C8 ≠ STM32F103C8T6），绝不能自动认成同一颗料。
        const exact = live.items.find((i) => normMpn(i.mpn) === normMpn(sc.mpn));
        if (exact) {
          const trust = assessTrust(sc.mpn, { mpn: exact.mpn, manufacturer: exact.manufacturer, pins: exact.pins }, { manufacturer: sc.manufacturer });
          mapped = {
            ...exact,
            mapSource: 'ezPLM云端',
            trust: { level: trust.level, evidence: trust.evidence, source: 'ezplm-exact', verifiedAt: now() },
          };
        } else {
          // 前缀/家族相似 → 仅记录候选供用户确认，不自动替换成 ezPLM 器件
          candidateHit = live.items.find((i) => normMpn(i.mpn).startsWith(normMpn(sc.mpn)) || normMpn(sc.mpn).startsWith(normMpn(i.mpn)));
        }
      }
      if (!mapped) {
        const cat = CAT_MAP[(sc.category ?? '').toLowerCase()] ?? 'passive';
        const trust: ComponentTrust = candidateHit
          ? {
              level: 'CANDIDATE',
              evidence: `数据库中最接近的是 ${candidateHit.mpn}，与 AI 建议 ${sc.mpn} 型号不完全一致，需人工确认后才可替换`,
              source: 'ezplm-candidate',
              verifiedAt: now(),
              candidate: { componentId: candidateHit.componentId, mpn: candidateHit.mpn, manufacturer: candidateHit.manufacturer },
            }
          : { level: 'PLACEHOLDER', evidence: '仅由模型建议，数据库未收录，需人工核对 datasheet', source: 'ai-only', verifiedAt: now() };
        // 无源件统一用 KiCad 官方符号/封装：同一种电容在画布上只有一种画法
        const passive = kicadPassiveDefaults('', sc.mpn ?? '', sc.reason ?? '', sc.footprint ?? '');
        mapped = {
          componentId: `fp_${sc.mpn}_${Math.random().toString(36).slice(2, 7)}`,
          mpn: sc.mpn || '未命名器件',
          manufacturer: sc.manufacturer ?? '—',
          category: cat,
          defaultFootprintName: passive?.footprint || sc.footprint || (cat === 'passive' ? 'C_0402_1005Metric' : 'SOIC-8'),
          symbolFromMpn: passive?.symbol,
          family: 'Footprint',
          description: `${sc.reason ?? ''}（${candidateHit ? `候选：${candidateHit.mpn}，待确认` : '未映射到 ezPLM，以封装占位'}）`.trim(),
          pins: 2,
          mapSource: candidateHit ? '候选待确认' : '封装占位',
          trust,
        } as ComponentSearchResult & { mapSource?: string; trust?: ComponentTrust };
      }
      if (sc.reason && !mapped.description?.includes(sc.reason)) mapped = { ...mapped, description: `${sc.reason} · ${mapped.description ?? ''}` };
      // 分组信息随器件带下去：UI 按「核心器件 + 附属器件」分组展示，上画布后用于成组布局
      mapped = { ...mapped!, group: sc.group?.trim() || undefined, core: sc.core === true, qty };
      for (let k = 0; k < qty; k++) items.push(mapped!);
    }

    return {
      componentIds: [],
      rationale: checked.data.summary ?? 'Gemini 方案',
      items,
      blocks: checked.data.blocks,
      blockLinks: checked.data.blockLinks,
    };
  }
}

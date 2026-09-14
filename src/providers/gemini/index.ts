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
/** AI 调用被拒（未登录 / 额度不足 / 后端未接通）—— UI 据此给出对应引导 */
export class AiAccessError extends Error {
  constructor(public code: 'LOGIN_REQUIRED' | 'INSUFFICIENT_CREDITS' | 'BACKEND_NOT_CONNECTED' | 'OTHER', message: string, public cost?: number) {
    super(message);
    this.name = 'AiAccessError';
  }
}

/**
 * @param capability 本次调用属于哪项能力（服务端据此按价目表扣 Credit）。
 *   客户端传的只是**标识**，费用以服务端价目表为准，改不动。
 */
export async function geminiComplete(prompt: string, capability: string = 'scheme.generate'): Promise<string> {
  const r = await fetch('/api/gemini', {
    method: 'POST',
    credentials: 'include',              // 带上 ezPLM / EEHub 会话
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, capability }),
  });
  const remaining = r.headers.get('X-Credits-Remaining');
  if (remaining != null) {
    const n = Number(remaining);
    if (Number.isFinite(n)) {
      const { useEntitlementStore } = await import('../../state/entitlementStore');
      useEntitlementStore.getState().setRemaining(n);
    }
  }
  if (!r.ok) {
    let code: 'LOGIN_REQUIRED' | 'INSUFFICIENT_CREDITS' | 'BACKEND_NOT_CONNECTED' | 'OTHER' = 'OTHER';
    let msg = `Gemini 代理 ${r.status}`;
    try {
      const j = await r.json();
      if (j?.code === 'LOGIN_REQUIRED' || j?.code === 'INSUFFICIENT_CREDITS' || j?.code === 'BACKEND_NOT_CONNECTED') code = j.code;
      if (j?.error) msg = String(j.error);
      throw new AiAccessError(code, msg, j?.cost);
    } catch (e) {
      if (e instanceof AiAccessError) throw e;
      throw new AiAccessError(code, msg);
    }
  }
  const j = await r.json();
  return String(j.text ?? '');
}

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
    // 多轮：带上一版方案 + 用户修改意见，让模型在既有方案上增删改
    const revision = req.previous && req.feedback
      ? `\n\n【上一版方案】\n${req.previous.summary ?? ''}\n器件清单：\n${req.previous.components.map((c) => `- ${c.mpn}${c.qty && c.qty > 1 ? ` ×${c.qty}` : ''}${c.group ? `（组：${c.group}${c.core ? '，核心' : ''}）` : ''}${c.reason ? ` — ${c.reason}` : ''}`).join('\n')}\n\n【用户修改意见】\n${req.feedback}\n\n请在上一版方案基础上按意见调整：保留未被提及的部分，只增删改必要的器件，并说明调整了什么。`
      : '';

    const prompt = `你是资深硬件工程师。用户需求：「${req.prompt}」${revision}

请设计一个完整可工作的电路方案，输出器件清单与方案框图。要求：

1. 主控/电源/接口等有源器件给出真实可购买的具体型号（如 STM32C011F4P6、AMS1117-3.3）
2. 无源器件（电阻/电容/电感）给出通用值型号（如 RC0402FR-0710KL）与封装
3. footprint 用 KiCad 命名规范（如 TSSOP-20_4.4x6.5mm_P0.65mm、R_0402_1005Metric、SOT-223）
4. category 取值：mcu / power / passive / connector / ic / sensor / rf / electromech
5. **按功能分组**：每个功能模块以一颗核心器件为中心，该模块的附属器件（去耦电容、
   上拉电阻、晶振及负载电容、限流电阻等）与核心器件用同一个 group 名（即核心器件的型号）；
   核心器件标 "core": true，每组至多一个核心器件。纯连接器可自成一组。
6. **方案框图**：blocks 是功能块（与分组一一对应），blockLinks 描述块之间的电源与信号走向；
   kind 取值 blocks: power|mcu|sensor|interface|storage|rf|display|other，links: power|signal|bus
7. 至多 12 个有源器件条目；summary 为 120 字内的方案思路

严格输出 JSON（勿输出其它任何文字）：
{"summary":"…",
 "components":[{"mpn":"…","footprint":"…","category":"…","reason":"用途简述","qty":1,"group":"核心器件型号","core":true}],
 "blocks":[{"id":"mcu","label":"主控","core":"STM32C011F4P6","kind":"mcu"}],
 "blockLinks":[{"from":"power","to":"mcu","label":"3V3","kind":"power"}]}`;

    const text = await geminiComplete(prompt);
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

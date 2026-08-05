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
import type { AiModelProvider, AiSchemeRequest, AiSchemeResult, AccessContext, ComponentSearchResult } from '../types';
import { searchEzplmParts, ezplmLiveAvailable } from '../ezplm-live';
import type { ComponentCategory } from '../../design-core/document/types';

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
export async function geminiComplete(prompt: string): Promise<string> {
  const r = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!r.ok) throw new Error(`Gemini 代理 ${r.status}`);
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

interface SchemeComp { mpn: string; footprint?: string; category?: string; role?: string; qty?: number }

const CAT_MAP: Record<string, ComponentCategory> = { mcu: 'mcu', power: 'power', passive: 'passive', connector: 'connector', ic: 'ic' };

export class GeminiAiProvider implements AiModelProvider {
  async generateScheme(req: AiSchemeRequest, _ctx: AccessContext): Promise<AiSchemeResult> {
    const prompt = `你是资深硬件工程师。用户需求：「${req.prompt}」

请设计一个完整可工作的电路方案，输出器件清单。要求：
1. 主控/电源/接口等有源器件给出真实可购买的具体型号（如 STM32C011F4P6、AMS1117-3.3）
2. 无源器件（电阻/电容/电感）给出通用值型号（如 RC0402FR-0710KL）与封装
3. footprint 用 KiCad 命名规范（如 TSSOP-20_4.4x6.5mm_P0.65mm、R_0402_1005Metric、SOT-223）
4. category 取值：mcu / power / passive / connector / ic
5. 至多 12 个条目；rationale 为 80 字内的方案思路

严格输出 JSON（勿输出其它任何文字）：
{"rationale":"…","components":[{"mpn":"…","footprint":"…","category":"…","role":"用途简述","qty":1}]}`;

    const text = await geminiComplete(prompt);
    const parsed = extractJson<{ rationale?: string; components?: SchemeComp[] }>(text);
    const comps = (parsed.components ?? []).slice(0, 12);
    if (!comps.length) throw new Error('模型未给出器件清单');

    const liveOk = await ezplmLiveAvailable();
    const items: (ComponentSearchResult & { mapSource?: string })[] = [];
    for (const sc of comps) {
      const qty = Math.max(1, Math.min(8, sc.qty ?? 1));
      let mapped: (ComponentSearchResult & { mapSource?: string }) | null = null;
      if (liveOk && sc.mpn) {
        // ezPLM 云端映射：搜索建议型号，取前缀匹配的首个
        const live = await searchEzplmParts(sc.mpn, 5).catch(() => ({ available: false, items: [] as ComponentSearchResult[] }));
        const hit = live.items.find((i) => i.mpn.toUpperCase().startsWith(sc.mpn.toUpperCase()))
          ?? live.items.find((i) => sc.mpn.toUpperCase().startsWith(i.mpn.toUpperCase()));
        if (hit) mapped = { ...hit, mapSource: 'ezPLM云端' };
      }
      if (!mapped) {
        // 未命中：封装占位（无源件典型路径），封装名交给解析器生成真实焊盘
        const cat = CAT_MAP[(sc.category ?? '').toLowerCase()] ?? 'passive';
        mapped = {
          componentId: `fp_${sc.mpn}_${Math.random().toString(36).slice(2, 7)}`,
          mpn: sc.mpn || '未命名器件',
          manufacturer: '—',
          category: cat,
          defaultFootprintName: sc.footprint || (cat === 'passive' ? '0402' : 'SOIC-8'),
          family: 'Footprint',
          description: `${sc.role ?? ''}（未映射到 ezPLM，以封装占位，可上画布后补全型号）`.trim(),
          pins: 2,
          mapSource: '封装占位',
        } as ComponentSearchResult & { mapSource?: string };
      }
      if (sc.role && !mapped.description?.includes(sc.role)) mapped = { ...mapped, description: `${sc.role} · ${mapped.description ?? ''}` };
      for (let k = 0; k < qty; k++) items.push(mapped);
    }

    return { componentIds: [], rationale: parsed.rationale ?? 'Gemini 方案', items };
  }
}

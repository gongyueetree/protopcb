/**
 * providers/gemini/index.ts
 * Gemini AI Provider —— 调用 Google Generative Language API 真实生成方案。
 * 需要环境变量 VITE_GEMINI_API_KEY（在 Vercel 项目 Settings → Environment Variables 配置）。
 * 未配置时工厂回退到 MockAiModelProvider。
 */
import type { AiModelProvider, AiSchemeRequest, AiSchemeResult, AccessContext } from '../types';
import { MOCK_COMPONENTS } from '../mock/data';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

/** Gemini Key：仅从 Vercel 环境变量 VITE_GEMINI_API_KEY 读取（Settings → Environment Variables 配置后 Redeploy） */
export function getGeminiKey(): string | null {
  const env = ((import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {}).VITE_GEMINI_API_KEY;
  return env?.trim() || null;
}

/** 通用一次性文本补全 */
export async function geminiComplete(prompt: string): Promise<string> {
  const key = getGeminiKey();
  if (!key) throw new Error('未配置 Gemini API Key');
  const res = await fetch(`${GEMINI_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4 } }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

export class GeminiAiProvider implements AiModelProvider {
  constructor(private apiKey: string) {}

  async generateScheme(req: AiSchemeRequest, _ctx: AccessContext): Promise<AiSchemeResult> {
    const catalog = MOCK_COMPONENTS.map((c) => `- id:${c.componentId} | ${c.mpn} | ${c.category} | ${c.description}`).join('\n');
    const prompt = `你是一名资深硬件工程师。用户需求："${req.prompt}"

可选元器件库（只能从下列 id 中选择）：
${catalog}

请为该需求选择合适的元器件组合（主控+电源+接口+必要外设+去耦阻容），并说明选型理由。
严格以 JSON 输出，不要任何其它文字：
{"componentIds":["id1","id2",...],"rationale":"选型理由(中文,80字内)"}`;

    const res = await fetch(`${GEMINI_URL}?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } }),
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}`);
    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const jsonStr = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(jsonStr) as { componentIds: string[]; rationale: string };
    const valid = new Set(MOCK_COMPONENTS.map((c) => c.componentId));
    return { componentIds: parsed.componentIds.filter((id) => valid.has(id)), rationale: parsed.rationale };
  }
}

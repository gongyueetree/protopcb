/**
 * design-core/custom-part-extract-contract.ts
 * 定制器件 AI 提取结果的**唯一**契约。
 *
 * 修复的回归：prompt 搬到服务端时，输出结构写成了 family/bodyW 在根对象，
 * 而前端 applyExtract 一直期待 package.family / package.bodyW —— 模型返回了尺寸，
 * 前端一个都收不到。根因是两边各写一份结构，没有共享定义。
 *
 * 这里的枚举**直接来自** custom-lib 的 CUSTOM_FAMILIES / CUSTOM_CATEGORIES，
 * 服务端 prompt 与校验器都从本文件生成，不再各自维护一份会过期的列表。
 */
import { z } from 'zod';
import { CUSTOM_FAMILIES, CUSTOM_CATEGORIES } from './custom-lib';

export const PIN_TYPES = ['input', 'output', 'bidirectional', 'tri_state', 'passive', 'free', 'unspecified',
  'power_in', 'power_out', 'open_collector', 'open_emitter', 'no_connect'] as const;
export const PIN_SIDES = ['top', 'bottom', 'left', 'right'] as const;

const optStr = (max: number) => z.string().max(max).nullish().transform((v) => v ?? undefined);
const optNum = () => z.number().finite().positive().nullish().transform((v) => v ?? undefined);

export const ExtractedPinSchema = z.object({
  num: z.union([z.string(), z.number()]).transform((v) => String(v)).pipe(z.string().min(1).max(8)),
  name: z.string().min(1).max(32),
  type: z.enum(PIN_TYPES).catch('passive'),
  desc: optStr(120),
  side: z.enum(PIN_SIDES).nullish().transform((v) => v ?? undefined),
});

export const ExtractedPackageSchema = z.object({
  family: z.enum(CUSTOM_FAMILIES).catch('manual'),
  bodyW: optNum(), bodyH: optNum(), pitch: optNum(),
  padLen: optNum(), padWidth: optNum(), leadSpan: optNum(), heightMm: optNum(),
  outlineW: optNum(), outlineH: optNum(),
  name: optStr(80),
});

export const CustomPartExtractionSchema = z.object({
  mpn: optStr(80),
  description: optStr(200),
  category: z.enum(CUSTOM_CATEGORIES).nullish().transform((v) => v ?? undefined),
  pins: z.array(ExtractedPinSchema).max(400).nullish().transform((v) => v ?? []),
  package: ExtractedPackageSchema.nullish().transform((v) => v ?? undefined),
});

export type CustomPartExtraction = z.infer<typeof CustomPartExtractionSchema>;

/** 服务端 prompt 用的 JSON 形状说明 —— 与 schema 同源，改枚举只改一处 */
export function extractionPromptShape(): string {
  return `{"mpn":"型号","description":"30字内功能描述","category":"${CUSTOM_CATEGORIES.join('|')}",
"pins":[{"num":"1","name":"VCC","type":"${PIN_TYPES.join('|')}","desc":"电源","side":"${PIN_SIDES.join('|')}"}],
"package":{"family":"${CUSTOM_FAMILIES.join('|')}","bodyW":4.9,"bodyH":3.9,"pitch":1.27,"leadSpan":6.0,"padLen":1.5,"padWidth":0.6,"heightMm":1.75,"outlineW":null,"outlineH":null,"name":"KiCad 封装名（如 SOIC-8_3.9x4.9mm_P1.27mm）"}}`;
}

/** 校验 + 规范化；失败返回可读原因 */
export function parseExtraction(raw: unknown): { ok: true; data: CustomPartExtraction } | { ok: false; error: string } {
  const r = CustomPartExtractionSchema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  return { ok: false, error: `${first?.path.join('.') || '根对象'}: ${first?.message ?? '结构不符'}` };
}

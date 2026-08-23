/**
 * 大模型输出的结构校验。
 *
 * 原则：数据事实由数据库 / KiCad / datasheet 提供，模型只负责推理；
 * 模型的猜测不允许悄悄变成工程事实。
 *
 * 因此所有 LLM 返回在进 store 之前必须过这一层：
 *   extractJson → Zod 结构校验 → 语义校验（数量/枚举/长度）→ 标注可信度 → UI
 * 校验失败就整条拒绝，绝不"尽力解析出一部分"——半个方案比没有方案更危险。
 */
import { z } from 'zod';

/** 器件可信等级：区分「数据库验证过」和「模型猜的」 */
export const TrustLevel = z.enum(['VERIFIED', 'CANDIDATE', 'PLACEHOLDER']);
export type TrustLevel = z.infer<typeof TrustLevel>;

const CATEGORY = z.enum(['mcu', 'power', 'passive', 'connector', 'sensor', 'rf', 'electromech', 'ic', 'other']);

/** 单个 AI 建议器件 */
export const AiComponentSchema = z.object({
  mpn: z.string().min(1).max(64),
  manufacturer: z.string().max(64).optional(),
  category: CATEGORY.catch('ic'),
  description: z.string().max(200).optional(),
  footprint: z.string().max(80).optional(),
  qty: z.number().int().min(1).max(64).catch(1),
  reason: z.string().max(200).optional(),
});
export type AiComponent = z.infer<typeof AiComponentSchema>;

/** AI 方案：整体设计建议 */
export const AiSchemeSchema = z.object({
  summary: z.string().max(600).optional(),
  boardWidthMm: z.number().positive().max(500).optional(),
  boardHeightMm: z.number().positive().max(500).optional(),
  components: z.array(AiComponentSchema).min(1).max(60),
});
export type AiScheme = z.infer<typeof AiSchemeSchema>;

/** AI 审查建议 */
export const AiAdvisorItemSchema = z.object({
  name: z.string().min(1).max(80),
  reason: z.string().max(300).optional(),
  severity: z.enum(['high', 'medium', 'low']).catch('medium'),
  refs: z.array(z.string().max(16)).max(40).optional(),
});
export const AiAdvisorSchema = z.object({
  items: z.array(AiAdvisorItemSchema).max(30),
});
export type AiAdvisorItem = z.infer<typeof AiAdvisorItemSchema>;

/** 子电路建议 */
export const AiSubCircuitItemSchema = z.object({
  role: z.string().min(1).max(40),
  value: z.string().min(1).max(40),
  mpn: z.string().max(64).optional(),
  category: CATEGORY.catch('passive'),
  footprint: z.string().max(80).optional(),
  connectsTo: z.string().max(24).optional(),
  qty: z.number().int().min(1).max(8).catch(1),
});
export const AiSubCircuitSchema = z.array(AiSubCircuitItemSchema).max(20);

export interface ValidationOutcome<T> {
  ok: boolean;
  data?: T;
  /** 面向用户的失败说明（可直接展示） */
  error?: string;
  /** 被丢弃的条目数（部分字段用 catch 兜底时不计入） */
  dropped?: number;
}

/**
 * 统一校验入口。失败时给出可读原因，绝不返回半成品。
 */
export function validateAi<S extends z.ZodTypeAny>(schema: S, raw: unknown, label: string): ValidationOutcome<z.output<S>> {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  const where = first?.path?.length ? first.path.join('.') : '根对象';
  return { ok: false, error: `${label}结构不符合预期（${where}：${first?.message ?? '未知问题'}）` };
}

/**
 * 器件可信等级判定 —— 只有数据库精确命中才算 VERIFIED。
 *
 * @param aiMpn      模型给出的型号
 * @param dbHit      数据库/分销商返回的候选（无则 undefined）
 */
export function assessTrust(
  aiMpn: string,
  dbHit?: { mpn: string; manufacturer?: string; pins?: number; footprint?: string },
  aiHint?: { manufacturer?: string; pins?: number },
): { level: TrustLevel; evidence: string } {
  const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!dbHit) {
    return { level: 'PLACEHOLDER', evidence: '仅由模型建议，数据库未收录，需人工核对 datasheet' };
  }
  const exact = norm(dbHit.mpn) === norm(aiMpn);
  if (!exact) {
    return { level: 'CANDIDATE', evidence: `数据库中最接近的是 ${dbHit.mpn}，型号不完全一致，需确认` };
  }
  // 型号精确命中后，再看厂商与管脚数是否冲突
  if (aiHint?.manufacturer && dbHit.manufacturer
    && norm(aiHint.manufacturer) !== norm(dbHit.manufacturer)) {
    return { level: 'CANDIDATE', evidence: `型号一致但厂商不符（库：${dbHit.manufacturer}）` };
  }
  if (aiHint?.pins && dbHit.pins && aiHint.pins !== dbHit.pins) {
    return { level: 'CANDIDATE', evidence: `型号一致但管脚数不符（库：${dbHit.pins}）` };
  }
  return { level: 'VERIFIED', evidence: `型号在库中精确命中${dbHit.manufacturer ? `（${dbHit.manufacturer}）` : ''}` };
}

/** 可信等级的展示属性 */
export const TRUST_META: Record<TrustLevel, { label: string; color: string; bg: string }> = {
  VERIFIED: { label: '已验证', color: '#15803d', bg: '#f0fdf4' },
  CANDIDATE: { label: '待确认', color: '#b45309', bg: '#fffbeb' },
  PLACEHOLDER: { label: '未验证', color: '#b91c1c', bg: '#fef2f2' },
};

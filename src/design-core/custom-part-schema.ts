/**
 * design-core/custom-part-schema.ts
 * 定制器件的结构校验 —— AI 提取结果与手工填写共用同一套 Zod。
 *
 * 原则（与 providers/ai-schema.ts 一致）：
 *   AI 提取的数据在进入表单前先过校验（丢弃非法字段，标注"未人工确认"）；
 *   保存前再整体强校验（重复脚号 / 非法尺寸直接拒绝，不产出半个器件）。
 */
import { z } from 'zod';
import { KICAD_PIN_TYPES, CUSTOM_FAMILIES, CUSTOM_CATEGORIES } from './custom-lib';

/** 有限正数（拦 NaN / Infinity / ≤0），带合理物理上限 */
const posMm = (max: number) => z.number().finite().positive().max(max);

export const CustomPinSchema = z.object({
  num: z.string().min(1, '脚号不能为空').max(8),
  name: z.string().min(1).max(48),
  type: z.enum(KICAD_PIN_TYPES),
  desc: z.string().max(120).optional(),
  side: z.enum(['left', 'right', 'top', 'bottom']).optional(),
});

export const ManualPadSchema = z.object({
  num: z.string().min(1).max(8),
  x: z.number().finite().min(-200).max(200),
  y: z.number().finite().min(-200).max(200),
  w: posMm(30),
  h: posMm(30),
  round: z.boolean().optional(),
});

export const CustomPkgSchema = z.object({
  family: z.enum(CUSTOM_FAMILIES),
  bodyW: posMm(200),
  bodyH: posMm(200),
  pitch: posMm(10),
  padLen: posMm(30).optional(),
  padWidth: posMm(30).optional(),
  leadSpan: posMm(200).optional(),
  heightMm: posMm(60).optional(),
  manualPads: z.array(ManualPadSchema).max(500).optional(),
  outlineW: posMm(300).optional(),
  outlineH: posMm(300).optional(),
  padsOffsetX: z.number().finite().min(-100).max(100).optional(),
  padsOffsetY: z.number().finite().min(-100).max(100).optional(),
});

export const CustomPartDraftSchema = z.object({
  mpn: z.string().min(1, '型号不能为空').max(64),
  description: z.string().max(200).optional(),
  category: z.enum(CUSTOM_CATEGORIES),
  pins: z.array(CustomPinSchema).min(1, '至少一个管脚').max(500),
  pkg: CustomPkgSchema,
})
  // 脚号必须唯一：硬件上重复 pad number 意味着两个焊盘同号，属于工程级错误
  .superRefine((v, ctx) => {
    const seen = new Map<string, number>();
    v.pins.forEach((p, i) => {
      const k = p.num.trim().toUpperCase();
      if (seen.has(k)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pins', i, 'num'], message: `脚号 ${p.num} 重复（与第 ${seen.get(k)! + 1} 行）` });
      } else {
        seen.set(k, i);
      }
    });
    if (v.pkg.family === 'manual') {
      const mp = v.pkg.manualPads ?? [];
      if (!mp.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pkg', 'manualPads'], message: '手动封装必须提供焊盘坐标表' });
      }
      const seenPad = new Set<string>();
      mp.forEach((p, i) => {
        const k = p.num.trim().toUpperCase();
        if (seenPad.has(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pkg', 'manualPads', i, 'num'], message: `焊盘号 ${p.num} 重复` });
        seenPad.add(k);
      });
    }
  });

export type CustomPartDraft = z.infer<typeof CustomPartDraftSchema>;

/** 校验草稿；失败给出首条可读原因（供保存按钮直接展示） */
export function validateCustomPartDraft(draft: unknown): { ok: true; data: CustomPartDraft } | { ok: false; error: string } {
  const r = CustomPartDraftSchema.safeParse(draft);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  const where = first?.path?.length ? first.path.join('.') : '';
  return { ok: false, error: `${where ? where + '：' : ''}${first?.message ?? '校验失败'}` };
}

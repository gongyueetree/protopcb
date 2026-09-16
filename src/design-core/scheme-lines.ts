/**
 * design-core/scheme-lines.ts
 * 方案行（SchemeLine）与展开（materialize）—— 纯函数。
 *
 * 修复的问题：方案里 `qty=4` 曾被展开成把**同一个对象 push 4 次**。
 * 展示层要靠 componentId 去重才不重复；删除一行会把同型号全删；React key 撞车。
 * 现在评审阶段保持"一行 × qty"，只有 Apply/Materialize 时才展开成 C1..C4，
 * 每个都有唯一 instanceId 与位号（由 placeScheme 分配）。
 */

export interface SchemeLine<T = unknown> {
  /** 行的唯一标识：删除/编辑都按它，而不是按 componentId */
  lineId: string;
  component: T;
  qty: number;
  groupId?: string;
  core?: boolean;
}

let seq = 0;
export const newLineId = () => `line_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** 把 provider 输出（含 qty/group/core）折成行；同一对象不再重复 */
export function toSchemeLines<T extends { qty?: number; group?: string; core?: boolean }>(items: T[]): SchemeLine<T>[] {
  return items.map((it) => ({
    lineId: newLineId(),
    component: it,
    qty: Math.max(1, Math.min(64, Number(it.qty) || 1)),
    groupId: it.group,
    core: it.core === true,
  }));
}

/**
 * 展开：每行按 qty 产出 qty 个**独立副本**（浅拷贝，避免同一引用），
 * 位号与 instanceId 由后续 placeScheme/nextReference 分配。
 */
export function materializeSchemeLines<T extends object>(lines: SchemeLine<T>[]): T[] {
  const out: T[] = [];
  for (const l of lines) for (let k = 0; k < l.qty; k++) out.push({ ...l.component });
  return out;
}

/** 删除一行：只删这一行，不按型号连坐 */
export function removeSchemeLine<T>(lines: SchemeLine<T>[], lineId: string): SchemeLine<T>[] {
  return lines.filter((l) => l.lineId !== lineId);
}

/** 汇总件数（评审页头部用） */
export const totalQty = <T,>(lines: SchemeLine<T>[]) => lines.reduce((a, l) => a + l.qty, 0);

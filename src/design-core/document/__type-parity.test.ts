/**
 * Phase 8：Runtime Schema 是 canonical。手写的 TS 类型必须与 z.infer 结构一致 ——
 * 不一致时这里在 typecheck 阶段就报错（不是运行期）。
 */
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import type { documentSchema } from './schema';
import type { CircuitCanvasDocument, PlacedComponent, BoardDefinition, BomLine, ReviewFinding } from './types';

type Inferred = z.infer<typeof documentSchema>;

/** 双向可赋值 = 结构等价（允许 readonly/optional 表达差异之外的一切都必须一致） */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// 若两边漂移，下面任一常量的类型推导会变成 never → tsc 报错
const docParity: MutuallyAssignable<Inferred, CircuitCanvasDocument> = true;
const compParity: MutuallyAssignable<Inferred['components'][number], PlacedComponent> = true;
const boardParity: MutuallyAssignable<Inferred['board'], BoardDefinition> = true;
const bomParity: MutuallyAssignable<Inferred['bom'][number], BomLine> = true;
const reviewParity: MutuallyAssignable<Inferred['reviewResults'][number], ReviewFinding> = true;

describe('types.ts 与 schema.ts 结构一致', () => {
  it('编译期已校验；运行期只确认常量存在', () => {
    expect(docParity && compParity && boardParity && bomParity && reviewParity).toBe(true);
  });
});

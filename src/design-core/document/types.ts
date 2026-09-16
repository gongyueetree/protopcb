/**
 * design-core/document/types.ts
 * 文档模型的 TS 类型 —— **全部由 Zod schema 推导**（schema.ts 是唯一的运行时真值）。
 * 此前这里手写了一整套几乎相同的 interface；两边一旦漂移，校验通过的文档在类型上却不成立。
 * 现在改字段只改 schema.ts；枚举在 enums.ts。
 */
import type { z } from 'zod';
import type {
  moneySchema, boardSchema, placedComponentSchema, functionalBlockSchema, connectionSchema,
  bomLineSchema, reviewFindingSchema, SchematicSheetSchema, documentSchema,
} from './schema';
import { RUN_MODES, COMPONENT_CATEGORIES, COMPONENT_SOURCES, TRUST_LEVELS, BOARD_SHAPES, CONNECTION_STYLES, REVIEW_LEVELS } from './enums';
/**
 * design-core/document/types.ts
 * 统一设计文档模型 (CircuitCanvasDocument)。
 * 这是本地保存、后端存储、ezPLM 附件、版本比较、AI 输入、KiCad 导出的统一格式。
 */
export type { FootprintGeometry, BoardSide, Polygon, Point } from '../geometry/types';

export { SCHEMA_VERSION } from './enums';

export type RunMode = (typeof RUN_MODES)[number];
export type ComponentCategory = (typeof COMPONENT_CATEGORIES)[number];
/**
 * 器件来源。生产数据不得因为"不属于 ezPLM"就被写成 MOCK —— MOCK 只给演示数据。
 * LOCAL 是旧文档里的兼容值（迁移时映射为 KICAD/CUSTOM 之一），新代码不要再写它。
 */
export type ComponentSource = (typeof COMPONENT_SOURCES)[number];
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export type Money = z.infer<typeof moneySchema>;

/* ---------- 板框 ---------- */
export type BoardShapeKind = (typeof BOARD_SHAPES)[number];

export type MountingHole = NonNullable<BoardDefinition['mountingHoles']>[number];

export type PlacementZone = NonNullable<BoardDefinition['placementZones']>[number];

export type KeepoutZone = NonNullable<BoardDefinition['keepoutZones']>[number];

export type BoardDefinition = z.infer<typeof boardSchema>;

/* ---------- 已放置器件 ---------- */
export type PlacedComponent = z.infer<typeof placedComponentSchema>;

/* ---------- 功能块 / 框图 ---------- */
export type FunctionalBlock = z.infer<typeof functionalBlockSchema>;

export type ConnectionStyle = (typeof CONNECTION_STYLES)[number];

export type LogicalConnection = z.infer<typeof connectionSchema>;

/* ---------- BOM ---------- */
export type BomLine = z.infer<typeof bomLineSchema>;

/* ---------- 设计审查 ---------- */
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

/* ---------- 顶层文档 ---------- */
/** 单页原理图（原样视图数据） */
export type SchematicSheetData = z.infer<typeof SchematicSheetSchema>;

export type CircuitCanvasDocument = z.infer<typeof documentSchema>;

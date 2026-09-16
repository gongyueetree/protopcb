/**
 * design-core/document/enums.ts
 * 文档模型的公共枚举 —— **唯一**定义处。
 * schema.ts 用 z.enum(X)，types.ts 用 (typeof X)[number]，不再各写一份字面量列表。
 */
/** 文档格式版本（与 package.json 的软件版本是两个概念，不要求相等） */
export const SCHEMA_VERSION = '3.2.0';

export const RUN_MODES = ['demo', 'standalone', 'integrated'] as const;
export const COMPONENT_CATEGORIES = ['mcu', 'power', 'passive', 'connector', 'ic', 'electromech', 'sensor', 'rf'] as const;
export const COMPONENT_SOURCES = [
  'EZPLM', 'ORGANIZATION', 'DIGIKEY', 'MOUSER', 'SUPPLIER',
  'KICAD', 'CUSTOM', 'AI', 'REFERENCE_DESIGN', 'IMPORTED_PROJECT', 'MOCK',
  'LOCAL',   // 旧文档兼容值；新代码不要写它
] as const;
export const TRUST_LEVELS = ['VERIFIED', 'CANDIDATE', 'PLACEHOLDER'] as const;
export const BOARD_SIDES = ['TOP', 'BOTTOM'] as const;
export const BOARD_SHAPES = ['rect', 'rounded', 'circle', 'lshape', 'polygon'] as const;
export const CONNECTION_STYLES = ['single', 'double', 'back', 'none', 'bus'] as const;
export const CONNECTION_DIRS = ['forward', 'back', 'both', 'none'] as const;
export const REVIEW_LEVELS = ['high', 'mid', 'low', 'info'] as const;
export const REVIEW_CATEGORIES = ['completeness', 'placement', 'thermal', 'emc', 'sourcing', 'mechanical'] as const;
export const LABEL_KINDS = ['local', 'global', 'hierarchical'] as const;
export const TEXT_ANCHORS = ['start', 'middle', 'end'] as const;
export const VIA_TYPES = ['blind', 'micro'] as const;

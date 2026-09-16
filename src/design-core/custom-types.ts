/**
 * design-core/custom-types.ts
 * 定制器件的引脚/手动焊盘基础类型 —— 叶子模块（custom-lib 与 custom-symbol 都依赖它，二者不再互相 import）。
 */
import enums from '../../contracts/custom-part-enums.json';

/** KiCad 电气引脚类型（唯一来源 contracts/custom-part-enums.json） */
export const KICAD_PIN_TYPES = enums.pinTypes as unknown as readonly ['input', 'output', 'bidirectional', 'tri_state', 'passive', 'free', 'unspecified', 'power_in', 'power_out', 'open_collector', 'open_emitter', 'no_connect'];
export type KicadPinType = (typeof KICAD_PIN_TYPES)[number];

export type PinSide = 'left' | 'right' | 'top' | 'bottom';
export interface CustomPin { num: string; name: string; type: KicadPinType; desc?: string; side?: PinSide }
export interface ManualPad { num: string; x: number; y: number; w: number; h: number; round?: boolean }

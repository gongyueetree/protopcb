/**
 * design-core/board/mounting-holes.ts
 * 定位孔的**唯一**入口。
 *
 * 修复的问题：`mountingHolesEnabled=true` 但 `mountingHoles=[]` 这种状态，
 * 各模块自行解释 —— collision 按四角推算、pcbExport 见空数组就只写默认孔、
 * 外壳按 holes.length 判断"没有孔位"、报告直接写"含四角定位孔 Ø3.2mm"。
 * 同一块板在 JSON / PCB / 3D / 外壳 / STL / CadQuery 里能得到不同的孔。
 *
 * 规则：孔的真值是 `board.mountingHoles`（真实坐标 + 真实孔径）；
 * `mountingHolesEnabled` 只是显示/启用开关。任何模块要孔，只能调
 * effectiveMountingHoles()，禁止再自己推算四角。
 */
import type { BoardDefinition } from '../document/types';

export interface MountingHole {
  position: { x: number; y: number };
  diameterMm: number;
}

/** 默认四角孔的边距与孔径（只在"启用但没有具体孔位"时用来 materialize） */
export const DEFAULT_HOLE_MARGIN_MM = 4;
export const DEFAULT_HOLE_DIAMETER_MM = 3.2;

/** L 型板缺口尺寸（与 collision 中的规则保持一致） */
function lshapeCut(board: BoardDefinition) {
  return { cutW: board.widthMm * 0.42, cutH: board.heightMm * 0.42 };
}

/**
 * 生成默认四角孔。仅用于"用户勾选了定位孔但还没有具体孔位"的情况，
 * 生成后应立即写回 board.mountingHoles，让真值只有一处。
 */
export function defaultCornerHoles(board: BoardDefinition, diameterMm = DEFAULT_HOLE_DIAMETER_MM): MountingHole[] {
  const m = DEFAULT_HOLE_MARGIN_MM, W = board.widthMm, H = board.heightMm;
  if (board.shape === 'circle') return [];                 // 圆板四角孔没有意义
  if (board.shape === 'lshape') {
    const { cutH } = lshapeCut(board);
    return [
      { position: { x: m, y: m }, diameterMm },
      { position: { x: W - m, y: m }, diameterMm },
      { position: { x: m, y: H - m }, diameterMm },
      { position: { x: W - m, y: H - cutH - m }, diameterMm },   // 缺口上沿以内
    ];
  }
  return [
    { position: { x: m, y: m }, diameterMm },
    { position: { x: W - m, y: m }, diameterMm },
    { position: { x: m, y: H - m }, diameterMm },
    { position: { x: W - m, y: H - m }, diameterMm },
  ];
}

/**
 * 该板**实际存在**的定位孔。所有模块（碰撞、2D、导出、3D、外壳、STL、CadQuery、报告）
 * 都必须从这里取，返回值即为最终事实。
 *
 * - 开关关闭 → 空数组（不管 mountingHoles 里有什么）
 * - 有具体孔位 → 原样返回（导入工程的真实孔径不会被默认值覆盖）
 * - 开关开着但没孔位 → 按默认四角生成（legacy 文档的兼容路径）
 */
export function effectiveMountingHoles(board: BoardDefinition): MountingHole[] {
  if (board.mountingHolesEnabled === false) return [];
  const holes = board.mountingHoles ?? [];
  if (holes.length) return holes.map((h) => ({ position: { ...h.position }, diameterMm: h.diameterMm }));
  if (!board.mountingHolesEnabled) return [];
  return defaultCornerHoles(board);
}

/**
 * 迁移：把 `enabled=true 但 holes=[]` 的旧文档补成真实孔位。
 * 返回是否发生了变更（供调用方决定要不要标记文档已更新）。
 */
export function materializeMountingHoles(board: BoardDefinition): boolean {
  if (!board.mountingHolesEnabled) return false;
  if (board.mountingHoles?.length) return false;
  const holes = defaultCornerHoles(board);
  if (!holes.length) return false;
  board.mountingHoles = holes;
  return true;
}

/** 供报告/审查描述用的一句话（避免各处再拼措辞） */
export function describeMountingHoles(board: BoardDefinition): string {
  const holes = effectiveMountingHoles(board);
  if (!holes.length) return '无定位孔';
  const ds = [...new Set(holes.map((h) => h.diameterMm.toFixed(1)))].join('/');
  return `${holes.length} 个定位孔 Ø${ds}mm`;
}

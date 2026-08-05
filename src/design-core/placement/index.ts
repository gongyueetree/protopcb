/**
 * design-core/placement/index.ts
 * 放置引擎 —— 根据 PlacementRule 配置为器件求解一个不冲突的位置。
 * 纯函数：输入(器件, 已放置, 板框, 规则) → 输出中心点(mm)。
 */
import type { PlacedComponent, BoardDefinition } from '../document/types';
import type { PlacementRule } from '../rules/types';
import { DEFAULT_PLACEMENT_RULES } from '../rules/types';
import { componentRect, boardRect, BOARD_MARGIN_MM, DEFAULT_GAP_MM, mountingHoleRects } from '../collision';
import { rectsOverlap, clampRectInside, type Rect, type Point } from '../geometry';

export { DEFAULT_PLACEMENT_RULES };

interface PlaceContext {
  board: BoardDefinition;
  existing: PlacedComponent[];
  rules: PlacementRule[];
}

/** 为单个器件求解放置位置（中心点 mm）。 */
export function solvePlacement(comp: PlacedComponent, ctx: PlaceContext): Point {
  const rule = pickRule(comp, ctx.rules);
  const rect = componentRect(comp);
  const w = rect.width, h = rect.height;
  const board = ctx.board;
  const occupied = [...ctx.existing.map(componentRect), ...mountingHoleRects(ctx.board)];

  let anchor: Point;

  // 辅件锚定：归属核心已放置 → 以其为圆心螺旋找邻近空位（去耦贴电源脚的近似）
  const anchorRef = comp.display?.anchorRef;
  const anchorComp = anchorRef ? ctx.existing.find((e) => e.reference === anchorRef) : undefined;
  if (anchorComp) {
    anchor = { x: anchorComp.placement.xMm, y: anchorComp.placement.yMm };
    const free0 = spiralFree(anchor, w, h, occupied);
    return clampCenter(free0, w, h, board);
  }

  if (rule?.type === 'EDGE_ALIGN') {
    anchor = edgeAnchor(rule, board, w, h);
  } else if (rule?.type === 'INSIDE_ZONE') {
    anchor = zoneGridSearch(rule, board, w, h, occupied) ?? zoneCenter(rule, board);
  } else if (rule?.type === 'NEAR_COMPONENT') {
    anchor = nearAnchor(rule, ctx, w, h);
  } else {
    anchor = { x: board.widthMm / 2, y: board.heightMm / 2 };
  }

  const free = spiralFree(anchor, w, h, occupied);
  return clampCenter(free, w, h, board);
}

/** 批量放置：依次为列表中的器件求解，后放的避开先放的。 */
export function autoPlaceAll(
  comps: PlacedComponent[],
  board: BoardDefinition,
  rules: PlacementRule[] = DEFAULT_PLACEMENT_RULES
): PlacedComponent[] {
  const placed: PlacedComponent[] = [];
  for (const c of comps) {
    const pos = solvePlacement(c, { board, existing: placed, rules });
    placed.push({ ...c, placement: { ...c.placement, xMm: pos.x, yMm: pos.y } });
  }
  return placed;
}

/* ---------- 内部 ---------- */

function pickRule(comp: PlacedComponent, rules: PlacementRule[]): PlacementRule | undefined {
  const family = comp.display?.family ?? '';
  const candidates = rules
    .filter((r) => r.appliesTo === comp.category)
    .filter((r) => !r.params.family || family.toLowerCase().includes(r.params.family.toLowerCase()))
    .sort((a, b) => b.priority - a.priority);
  return candidates[0];
}

function edgeAnchor(rule: PlacementRule, board: BoardDefinition, w: number, h: number): Point {
  const ratio = rule.params.edgeRatio ?? 0.5;
  const m = BOARD_MARGIN_MM + 1;
  switch (rule.params.edge) {
    case 'left': return { x: m + w / 2, y: board.heightMm * ratio };
    case 'right': return { x: board.widthMm - m - w / 2, y: board.heightMm * ratio };
    case 'top': return { x: board.widthMm * ratio, y: m + h / 2 };
    case 'bottom': default: return { x: board.widthMm * ratio, y: board.heightMm - m - h / 2 };
  }
}

function zoneRect(rule: PlacementRule, board: BoardDefinition): Rect | null {
  const zone = board.placementZones.find((z) => z.id === rule.params.zoneId);
  if (!zone) return null;
  const [x0, y0, x1, y1] = zone.normRect;
  return { x: x0 * board.widthMm, y: y0 * board.heightMm, width: (x1 - x0) * board.widthMm, height: (y1 - y0) * board.heightMm };
}

function zoneCenter(rule: PlacementRule, board: BoardDefinition): Point {
  const r = zoneRect(rule, board);
  if (!r) return { x: board.widthMm / 2, y: board.heightMm / 2 };
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function zoneGridSearch(rule: PlacementRule, board: BoardDefinition, w: number, h: number, occupied: Rect[]): Point | null {
  const zr = zoneRect(rule, board);
  if (!zr) return null;
  const gap = DEFAULT_GAP_MM;
  for (let cy = zr.y + h / 2; cy <= zr.y + zr.height - h / 2; cy += h + gap) {
    for (let cx = zr.x + w / 2; cx <= zr.x + zr.width - w / 2; cx += w + gap) {
      const cand: Rect = { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
      if (!occupied.some((o) => rectsOverlap(cand, o, gap))) return { x: cx, y: cy };
    }
  }
  return null;
}

function nearAnchor(rule: PlacementRule, ctx: PlaceContext, w: number, h: number): Point {
  const parent = [...ctx.existing].reverse().find((c) => c.category === rule.params.nearCategory)
    ?? [...ctx.existing].reverse().find((c) => c.category === 'ic');
  if (!parent) return { x: ctx.board.widthMm / 2, y: ctx.board.heightMm / 2 };
  const pr = componentRect(parent);
  return { x: pr.x + pr.width + DEFAULT_GAP_MM + w / 2, y: pr.y + h / 2 };
}

/** 从 anchor 开始螺旋探测，找到不与 occupied 重叠的中心点。 */
function spiralFree(anchor: Point, w: number, h: number, occupied: Rect[]): Point {
  const gap = DEFAULT_GAP_MM;
  const test = (cx: number, cy: number): boolean => {
    const r: Rect = { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
    return !occupied.some((o) => rectsOverlap(r, o, gap));
  };
  if (test(anchor.x, anchor.y)) return anchor;
  for (let i = 1; i < 40; i++) {
    const angle = i * 2.4;
    const radius = (gap + Math.max(w, h) * 0.5) * (1 + i * 0.25);
    const cx = anchor.x + Math.cos(angle) * radius;
    const cy = anchor.y + Math.sin(angle) * radius;
    if (test(cx, cy)) return { x: cx, y: cy };
  }
  return anchor;
}

function clampCenter(center: Point, w: number, h: number, board: BoardDefinition): Point {
  const r: Rect = { x: center.x - w / 2, y: center.y - h / 2, width: w, height: h };
  const tl = clampRectInside(r, boardRect(board), BOARD_MARGIN_MM);
  return { x: tl.x + w / 2, y: tl.y + h / 2 };
}

/**
 * design-core/enclosure/openings.ts
 * 外壳开孔与固定方式 —— 全部由器件几何确定性推导，不含任何推断。
 *
 * 规则（可核对）：
 *   本体越过板边或紧贴板边的连接器  → 侧壁开孔（开在最近的那面墙）
 *   顶面的 LED / 显示屏 / 按键        → 顶盖开窗（LED 圆孔、屏幕矩形窗、按键圆孔）
 *   有定位孔                          → 螺柱固定（柱位=孔位）
 *   无定位孔                          → 卡扣固定（沿长边均布）
 *
 * 每个开孔都带上来源位号，UI 上能说清"这个孔是给谁开的"。
 * 判不准的（例如器件类别识别不出）一律不开孔，宁可漏也不臆造。
 */
import type { CircuitCanvasDocument, PlacedComponent, BoardDefinition } from '../document/types';
import { padFootprintFor } from '../geometry/footprint-pads';
import { componentBodyHeight } from './index';
import { effectiveMountingHoles } from '../board/mounting-holes';

export type OpeningFace = 'left' | 'right' | 'front' | 'back' | 'top';
export type OpeningShape = 'rect' | 'circle';

export interface Opening {
  /** 来源器件位号 */
  reference: string;
  mpn: string;
  face: OpeningFace;
  shape: OpeningShape;
  /** 开孔中心，在该面的局部坐标（mm，以面中心为原点） */
  cx: number;
  cy: number;
  /** 矩形尺寸 / 圆孔直径（circle 时 w 即直径） */
  w: number;
  h: number;
  /** 判定依据，展示给用户 */
  reason: string;
}

export interface MountingPlan {
  kind: 'screw-post' | 'snap-fit';
  /** 柱位/卡扣位（板坐标 mm） */
  positions: { x: number; y: number }[];
  detail: string;
}

/** 器件本体在板坐标下的包围盒（考虑旋转 90° 时长宽互换） */
export function bodyRectOf(c: PlacedComponent): { x0: number; y0: number; x1: number; y1: number; w: number; h: number } {
  const fp = padFootprintFor(c.footprint.name);
  const bw = fp?.bodyW ?? c.footprint.geometry.bodyWidthMm;
  const bh = fp?.bodyH ?? c.footprint.geometry.bodyHeightMm;
  const rot = ((c.placement.rotation % 180) + 180) % 180;
  const w = rot === 90 ? bh : bw;
  const h = rot === 90 ? bw : bh;
  return {
    x0: c.placement.xMm - w / 2, y0: c.placement.yMm - h / 2,
    x1: c.placement.xMm + w / 2, y1: c.placement.yMm + h / 2, w, h,
  };
}

const isConnector = (c: PlacedComponent) => c.category === 'connector'
  || /^(J|P|CN|USB)[0-9]/i.test(c.reference)
  || /(USB|HDMI|RJ45|JACK|HEADER|RECEPTACLE|CONN|SD_|MICROSD)/i.test(c.footprint.name);
const isLed = (c: PlacedComponent) => /^(D|LED|DS)[0-9]/i.test(c.reference) && /LED/i.test(`${c.footprint.name} ${c.mpn} ${c.display?.family ?? ''}`);
const isButton = (c: PlacedComponent) => /^(SW|S|K|BTN)[0-9]/i.test(c.reference)
  || /(SW_|SWITCH|TACT|BUTTON|PUSH)/i.test(c.footprint.name);
const isDisplay = (c: PlacedComponent) => /(OLED|LCD|TFT|DISPLAY|SSD1306|ST7789|SCREEN)/i.test(`${c.mpn} ${c.footprint.name} ${c.display?.description ?? ''}`);

/**
 * 推导全部开孔。
 * @param edgeTolMm 器件本体到板边多近才算"需要侧壁开孔"（默认 2mm；越过板边必开）
 */
export function deriveOpenings(doc: CircuitCanvasDocument, edgeTolMm = 2): Opening[] {
  const B = doc.board;
  const out: Opening[] = [];

  for (const c of doc.components) {
    const r = bodyRectOf(c);
    const hMm = componentBodyHeight(c.footprint.name).bodyMm;

    // ── 侧壁开孔：对外连接器 ──
    if (isConnector(c)) {
      const dLeft = r.x0, dRight = B.widthMm - r.x1, dFront = r.y0, dBack = B.heightMm - r.y1;
      const min = Math.min(dLeft, dRight, dFront, dBack);
      if (min <= edgeTolMm) {
        const face: OpeningFace = min === dLeft ? 'left' : min === dRight ? 'right' : min === dFront ? 'front' : 'back';
        const horizontal = face === 'front' || face === 'back';
        // 开孔宽度取器件沿该墙方向的本体尺寸 + 单边 0.5mm 装配间隙
        const span = (horizontal ? r.w : r.h) + 1.0;
        out.push({
          reference: c.reference, mpn: c.mpn, face, shape: 'rect',
          // 面内横坐标：沿墙方向相对板中心的偏移；纵坐标：以 PCB 面为 0，向上为正
          cx: horizontal ? c.placement.xMm - B.widthMm / 2 : c.placement.yMm - B.heightMm / 2,
          cy: hMm / 2,
          w: span, h: hMm + 1.0,
          reason: `${c.reference} ${min < 0 ? '本体越过板边' : `距板边 ${min.toFixed(1)}mm`}，需侧壁开孔`,
        });
      }
      continue;
    }

    // ── 顶盖开窗/开孔：顶面的显示屏、LED、按键 ──
    if (c.placement.side !== 'TOP') continue;
    const cx = c.placement.xMm - B.widthMm / 2;
    const cy = c.placement.yMm - B.heightMm / 2;
    if (isDisplay(c)) {
      out.push({
        reference: c.reference, mpn: c.mpn, face: 'top', shape: 'rect',
        cx, cy, w: r.w, h: r.h,                       // 显示窗按本体尺寸，不放大（避免露出屏体边框）
        reason: `${c.reference} 为显示器件，顶盖开窗`,
      });
    } else if (isButton(c)) {
      const d = Math.min(r.w, r.h) + 1.0;
      out.push({ reference: c.reference, mpn: c.mpn, face: 'top', shape: 'circle', cx, cy, w: d, h: d, reason: `${c.reference} 为按键，顶盖开按钮孔` });
    } else if (isLed(c)) {
      out.push({ reference: c.reference, mpn: c.mpn, face: 'top', shape: 'circle', cx, cy, w: 3.0, h: 3.0, reason: `${c.reference} 为指示灯，顶盖开导光孔 Ø3mm` });
    }
  }
  return out;
}

/** 固定方式：有定位孔用螺柱，没有则沿长边均布卡扣 */
export function deriveMounting(board: BoardDefinition): MountingPlan {
  const holes = effectiveMountingHoles(board);
  if (holes.length) {
    return {
      kind: 'screw-post',
      positions: holes.map((h) => ({ x: h.position.x, y: h.position.y })),
      detail: `按 ${holes.length} 个定位孔生成螺柱（孔径 ${holes.map((h) => h.diameterMm.toFixed(1)).join('/')}mm）`,
    };
  }
  // 无定位孔：上下壳卡扣，沿较长的一对边各布 2 个
  const { widthMm: W, heightMm: H } = board;
  const alongX = W >= H;
  const positions = alongX
    ? [{ x: W * 0.3, y: 0 }, { x: W * 0.7, y: 0 }, { x: W * 0.3, y: H }, { x: W * 0.7, y: H }]
    : [{ x: 0, y: H * 0.3 }, { x: 0, y: H * 0.7 }, { x: W, y: H * 0.3 }, { x: W, y: H * 0.7 }];
  return { kind: 'snap-fit', positions, detail: '板上无定位孔，采用上下壳卡扣固定（沿长边各 2 处）' };
}

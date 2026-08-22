/**
 * KiCad 5 旧版符号库（.lib / -cache.lib）解析器。
 *
 * 老工程的原理图（.sch）只写"用了哪个符号"，符号的图形定义在同目录的
 * `<工程名>-cache.lib` 里。不解析它，导入的原理图就只有连线没有器件图形。
 *
 * 格式（行式，单位 mil）：
 *   DEF 名称 位号前缀 0 偏移 Y Y 单元数 F N
 *   DRAW
 *     S x1 y1 x2 y2 unit conv 线宽 填充      矩形
 *     P 点数 unit conv 线宽 x1 y1 x2 y2 … 填充   折线
 *     C cx cy 半径 unit conv 线宽 填充        圆
 *     A cx cy 半径 起角 止角 unit conv 线宽 填充 x1 y1 x2 y2   圆弧
 *     X 名称 脚号 x y 长度 方向 数字尺寸 名字尺寸 unit conv 电气类型
 *   ENDDRAW / ENDDEF
 *
 * 输出坐标统一转 mm，并把管脚方向（U/D/L/R）换算成端点，供渲染直接使用。
 */

const MIL_TO_MM = 0.0254;

export interface LegacySymGeom {
  rects: { x1: number; y1: number; x2: number; y2: number }[];
  polys: { x: number; y: number }[][];
  circles: { cx: number; cy: number; r: number }[];
  arcs: { x1: number; y1: number; xm: number; ym: number; x2: number; y2: number }[];
  /** 管脚：根部(x,y) → 端点(ex,ey) */
  pins: { x: number; y: number; ex: number; ey: number; number: string; name: string }[];
}

/** 解析整个 .lib，返回 符号名 → 几何 */
export function parseLegacyLib(text: string): Record<string, LegacySymGeom> {
  const out: Record<string, LegacySymGeom> = {};
  const lines = text.split(/\r?\n/);
  const mm = (v: number) => +(v * MIL_TO_MM).toFixed(4);

  for (let i = 0; i < lines.length; i++) {
    const def = lines[i].match(/^DEF\s+(\S+)/);
    if (!def) continue;
    // KiCad 5 库名里的 ~ 前缀表示"值不可见"，与图形无关
    const name = def[1].replace(/^~/, '');
    const g: LegacySymGeom = { rects: [], polys: [], circles: [], arcs: [], pins: [] };

    for (i++; i < lines.length && !/^ENDDEF/.test(lines[i]); i++) {
      const l = lines[i].trim();

      // 矩形
      const S = l.match(/^S\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
      if (S) { g.rects.push({ x1: mm(+S[1]), y1: mm(-+S[2]), x2: mm(+S[3]), y2: mm(-+S[4]) }); continue; }

      // 折线：P 点数 unit conv 线宽 x1 y1 x2 y2 …
      const P = l.match(/^P\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(.*)$/);
      if (P) {
        const n = parseInt(P[1], 10);
        const nums = (P[2].match(/-?\d+/g) ?? []).map(Number);
        const pts: { x: number; y: number }[] = [];
        for (let k = 0; k < n && k * 2 + 1 < nums.length; k++) {
          pts.push({ x: mm(nums[k * 2]), y: mm(-nums[k * 2 + 1]) });
        }
        if (pts.length >= 2) g.polys.push(pts);
        continue;
      }

      // 圆
      const C = l.match(/^C\s+(-?\d+)\s+(-?\d+)\s+(\d+)/);
      if (C) { g.circles.push({ cx: mm(+C[1]), cy: mm(-+C[2]), r: mm(+C[3]) }); continue; }

      // 圆弧：末尾四个数是起止点坐标
      const A = l.match(/^A\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+\d+\s+\d+\s+\d+\s+\S+\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
      if (A) {
        const cx = +A[1], cy = +A[2], r = +A[3];
        const a1 = (+A[4] / 10) * Math.PI / 180, a2 = (+A[5] / 10) * Math.PI / 180;
        const am = (a1 + a2) / 2;
        g.arcs.push({
          x1: mm(+A[6]), y1: mm(-+A[7]),
          xm: mm(cx + r * Math.cos(am)), ym: mm(-(cy + r * Math.sin(am))),
          x2: mm(+A[8]), y2: mm(-+A[9]),
        });
        continue;
      }

      // 管脚：X 名称 脚号 x y 长度 方向 …
      const X = l.match(/^X\s+(\S+)\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+([UDLR])/);
      if (X) {
        const px = +X[3], py = +X[4], len = +X[5], dir = X[6];
        // KiCad 5 中 (x,y) 是管脚"连接端"，方向指向本体外侧
        const ex = dir === 'L' ? px + len : dir === 'R' ? px - len : px;
        const ey = dir === 'U' ? py - len : dir === 'D' ? py + len : py;
        g.pins.push({
          x: mm(px), y: mm(-py),
          ex: mm(ex), ey: mm(-ey),
          name: X[1] === '~' ? '' : X[1],
          number: X[2],
        });
        continue;
      }
    }
    out[name] = g;
  }
  return out;
}

/** 是否为 KiCad 5 旧版符号库文本 */
export function isLegacyLib(text: string): boolean {
  return /^EESchema-LIBRARY/m.test(text.slice(0, 300));
}

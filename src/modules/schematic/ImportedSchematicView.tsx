/**
 * KiCad 原理图原样视图（只读）——按 .kicad_sch 的真实坐标渲染：
 * 器件实例（含电源符号）+ 连线 + 结点 + 标签 + no_connect。
 *
 * 坐标约定：sch 文件 Y 向下；符号库内部几何 Y 向上。
 * 实例变换：先 Y 翻转进 sch 局部系 → 镜像 → 旋转（KiCad 逆时针角度）→ 平移到 (at x y)。
 */
import { useMemo, useRef, useState } from 'react';
import type { CircuitCanvasDocument } from '../../design-core/document/types';
import { rawSymbolGeom } from '../../design-core/geometry/kicad-sch-import';

const PXMM = 6; // px per mm

type Pt = { x: number; y: number };

function makeXform(inst: { x: number; y: number; rot: number; mirror?: string }) {
  const rad = (inst.rot * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return (px: number, py: number): Pt => {
    // 符号 Y-up → sch 局部 Y-down
    let sx = px, sy = -py;
    if (inst.mirror === 'x') sy = -sy;
    if (inst.mirror === 'y') sx = -sx;
    // KiCad 逆时针旋转（屏幕 Y 向下坐标系中表现为：角度增大逆时针）
    const rx = sx * cos + sy * sin;
    const ry = -sx * sin + sy * cos;
    return { x: (inst.x + rx) * PXMM, y: (inst.y + ry) * PXMM };
  };
}

function arcPts(p1: Pt, pm: Pt, p2: Pt): string {
  const d = 2 * (p1.x * (pm.y - p2.y) + pm.x * (p2.y - p1.y) + p2.x * (p1.y - pm.y));
  if (Math.abs(d) < 1e-6) return `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} L${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  const ux = ((p1.x ** 2 + p1.y ** 2) * (pm.y - p2.y) + (pm.x ** 2 + pm.y ** 2) * (p2.y - p1.y) + (p2.x ** 2 + p2.y ** 2) * (p1.y - pm.y)) / d;
  const uy = ((p1.x ** 2 + p1.y ** 2) * (p2.x - pm.x) + (pm.x ** 2 + pm.y ** 2) * (p1.x - p2.x) + (p2.x ** 2 + p2.y ** 2) * (pm.x - p1.x)) / d;
  const r = Math.hypot(p1.x - ux, p1.y - uy);
  const a1 = Math.atan2(p1.y - uy, p1.x - ux);
  const am = Math.atan2(pm.y - uy, pm.x - ux);
  const a2 = Math.atan2(p2.y - uy, p2.x - ux);
  const norm = (t: number) => { let v = t; while (v < 0) v += Math.PI * 2; return v % (Math.PI * 2); };
  let sweep = norm(a2 - a1);
  if (norm(am - a1) > sweep + 1e-9) sweep -= Math.PI * 2;
  const out: string[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = a1 + (sweep * i) / 14;
    out.push(`${i === 0 ? 'M' : 'L'}${(ux + r * Math.cos(t)).toFixed(1)},${(uy + r * Math.sin(t)).toFixed(1)}`);
  }
  return out.join(' ');
}

export function ImportedSchematicView({ doc }: { doc: CircuitCanvasDocument }) {
  const sheet = doc.schematicSheet;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 20, y: 20 });
  const drag = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

  const content = useMemo(() => {
    if (!sheet) return null;
    const els: JSX.Element[] = [];
    // 连线
    sheet.wires.forEach((w, i) => {
      els.push(<polyline key={'w' + i} points={w.map(([x, y]) => `${x * PXMM},${y * PXMM}`).join(' ')} fill="none" stroke="#0a7d38" strokeWidth={1.4} />);
    });
    sheet.junctions.forEach(([x, y], i) => {
      els.push(<circle key={'j' + i} cx={x * PXMM} cy={y * PXMM} r={2.6} fill="#0a7d38" />);
    });
    sheet.noConnects.forEach(([x, y], i) => {
      const s = 3.5;
      els.push(<g key={'nc' + i} stroke="#2563eb" strokeWidth={1.2}>
        <line x1={x * PXMM - s} y1={y * PXMM - s} x2={x * PXMM + s} y2={y * PXMM + s} />
        <line x1={x * PXMM - s} y1={y * PXMM + s} x2={x * PXMM + s} y2={y * PXMM - s} />
      </g>);
    });
    // 器件实例
    sheet.instances.forEach((inst, ii) => {
      // 新格式：内嵌 lib_symbols 文本；旧格式（KiCad5）：-cache.lib 解析出的几何
      const block = sheet.libSymbols[inst.libId];
      const legKey = inst.libId.replace(':', '_');
      const legacy = sheet.legacySymbols?.[legKey] ?? sheet.legacySymbols?.[inst.libId];
      if (!block && !legacy) return;
      const g = block ? rawSymbolGeom(block) : {
        rects: legacy!.rects, polys: legacy!.polys, circles: legacy!.circles, arcs: legacy!.arcs,
        pins: legacy!.pins.map((pn) => ({ x: pn.x, y: pn.y, ex: pn.ex, ey: pn.ey, number: pn.number })),
      };
      const T = makeXform(inst);
      const kids: JSX.Element[] = [];
      g.rects.forEach((r, i) => {
        const c = [T(r.x1, r.y1), T(r.x2, r.y1), T(r.x2, r.y2), T(r.x1, r.y2)];
        kids.push(<polygon key={'r' + i} points={c.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} fill="#fffbd6" stroke="#8a1c1c" strokeWidth={1.3} />);
      });
      g.polys.forEach((pl, i) => {
        kids.push(<polyline key={'p' + i} points={pl.map((q) => { const a = T(q.x, q.y); return `${a.x.toFixed(1)},${a.y.toFixed(1)}`; }).join(' ')} fill="none" stroke="#8a1c1c" strokeWidth={1.3} />);
      });
      g.circles.forEach((ci, i) => {
        const a = T(ci.cx, ci.cy);
        kids.push(<circle key={'c' + i} cx={a.x} cy={a.y} r={ci.r * PXMM} fill="none" stroke="#8a1c1c" strokeWidth={1.3} />);
      });
      g.arcs.forEach((ar, i) => {
        kids.push(<path key={'a' + i} d={arcPts(T(ar.x1, ar.y1), T(ar.xm, ar.ym), T(ar.x2, ar.y2))} fill="none" stroke="#8a1c1c" strokeWidth={1.3} />);
      });
      const showPinNums = g.pins.length > 2;   // 两脚无源件（R/C/L…）与 KiCad 一致：不显示脚号
      g.pins.forEach((pn, i) => {
        const tip = T(pn.x, pn.y), end = T(pn.ex, pn.ey);
        kids.push(<line key={'pl' + i} x1={tip.x} y1={tip.y} x2={end.x} y2={end.y} stroke="#8a1c1c" strokeWidth={1.2} />);
        if (!showPinNums) return;
        // 脚号放在管脚中点、沿"法线方向"外移，避免竖直管脚的数字压在上下轮廓线上
        const mx = (tip.x + end.x) / 2, my = (tip.y + end.y) / 2;
        const dx = end.x - tip.x, dy = end.y - tip.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;   // 单位法线
        kids.push(<text key={'pn' + i} x={mx + nx * 5} y={my + ny * 5 + 2} fontSize={6.5} fill="#7c2d12" textAnchor="middle">{pn.number}</text>);
      });
      // 位号（电源符号不标）
      if (!inst.ref.startsWith('#')) {
        // 位号紧贴本体上沿、值贴下沿：本体范围取图元包围盒（原来固定 -18 会离小符号很远）
        const ys: number[] = [];
        g.rects.forEach((r2) => { ys.push(T(r2.x1, r2.y1).y, T(r2.x2, r2.y2).y); });
        g.polys.forEach((pl) => pl.forEach((pt) => ys.push(T(pt.x, pt.y).y)));
        g.circles.forEach((ci) => { ys.push(T(ci.cx, ci.cy - ci.r).y, T(ci.cx, ci.cy + ci.r).y); });
        g.pins.forEach((pn) => ys.push(T(pn.x, pn.y).y));
        const cy0 = T(0, 0).y;
        const bodyTop = ys.length ? Math.min(...ys) : cy0 - 8;
        const bodyBot = ys.length ? Math.max(...ys) : cy0 + 8;
        const cxp = T(0, 0).x;
        kids.push(<text key="ref" x={cxp} y={bodyTop - 3} fontSize={8.5} fontWeight={700} fill="#0e7490" textAnchor="middle" fontFamily="monospace"
          style={{ paintOrder: 'stroke' }} stroke="#fafaf6" strokeWidth={3}>{inst.ref}</text>);
        if (inst.value && inst.value !== inst.ref) {
          kids.push(<text key="val" x={cxp} y={bodyBot + 9} fontSize={8} fill="#7c2d12" textAnchor="middle" fontFamily="monospace"
            style={{ paintOrder: 'stroke' }} stroke="#fafaf6" strokeWidth={3}>{inst.value}</text>);
        }
      }
      els.push(<g key={'inst' + ii}>{kids}</g>);
    });
    // 总线（粗）与总线入口（斜线）
    (sheet.buses ?? []).forEach((b, i) => {
      const [a, c2] = b;
      els.push(<line key={'bus' + i} x1={a[0] * PXMM} y1={a[1] * PXMM} x2={c2[0] * PXMM} y2={c2[1] * PXMM}
        stroke="#1d4ed8" strokeWidth={3.2} strokeLinecap="round" />);
    });
    (sheet.busEntries ?? []).forEach((b, i) => {
      const [a, c2] = b;
      els.push(<line key={'be' + i} x1={a[0] * PXMM} y1={a[1] * PXMM} x2={c2[0] * PXMM} y2={c2[1] * PXMM}
        stroke="#1d4ed8" strokeWidth={1.6} />);
    });

    // 图框与标题栏
    if (sheet.frame) {
      const F = sheet.frame;
      const fw = F.wMm * PXMM, fh = F.hMm * PXMM;
      els.unshift(
        <g key="frame">
          <rect x={0} y={0} width={fw} height={fh} fill="none" stroke="#8a1c1c" strokeWidth={1.4} />
          <rect x={3 * PXMM} y={3 * PXMM} width={fw - 6 * PXMM} height={fh - 6 * PXMM} fill="none" stroke="#8a1c1c" strokeWidth={0.7} />
          <g transform={`translate(${fw - 78 * PXMM}, ${fh - 26 * PXMM})`}>
            <rect x={0} y={0} width={75 * PXMM} height={23 * PXMM} fill="#fffef9" stroke="#8a1c1c" strokeWidth={0.9} />
            {F.title && <text x={4} y={13} fontSize={11} fontWeight={700} fill="#7c2d12">{F.title}</text>}
            <text x={4} y={27} fontSize={8} fill="#7c2d12">{[F.company, F.date, F.rev ? 'Rev ' + F.rev : ''].filter(Boolean).join(' · ')}</text>
            {(F.comments ?? []).slice(0, 2).map((cm, i) => (
              <text key={i} x={4} y={39 + i * 11} fontSize={7.5} fill="#a16207">{cm}</text>
            ))}
          </g>
        </g>,
      );
    }

    // 标签
    sheet.labels.forEach((lb, i) => {
      // KiCad 标签的 180° 是"向左书写"而非镜像翻转 —— 用锚点表达，避免文字倒置
      const r = ((lb.rot % 360) + 360) % 360;
      const anchor = r === 180 ? 'end' : 'start';
      const rot = r === 90 ? -90 : r === 270 ? -90 : 0;
      els.push(<text key={'lb' + i} x={lb.x * PXMM} y={lb.y * PXMM - 2} fontSize={8} fill="#166534" fontFamily="monospace"
        textAnchor={anchor}
        transform={rot ? `rotate(${rot} ${lb.x * PXMM} ${lb.y * PXMM})` : undefined}>{lb.text}</text>);
    });
    return els;
  }, [sheet]);

  if (!sheet) return null;
  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#fafaf6', cursor: 'grab' }}
      onWheel={(e) => { e.preventDefault(); setZoom((z) => Math.min(4, Math.max(0.15, z * (e.deltaY < 0 ? 1.12 : 0.9)))); }}
      onMouseDown={(e) => { drag.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }; }}
      onMouseMove={(e) => { if (drag.current) setPan({ x: drag.current.px + e.clientX - drag.current.sx, y: drag.current.py + e.clientY - drag.current.sy }); }}
      onMouseUp={() => { drag.current = null; }}
      onMouseLeave={() => { drag.current = null; }}>
      <svg width="100%" height="100%">
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>{content}</g>
      </svg>
      <div style={{ position: 'absolute', top: 8, right: 10, fontSize: 10, color: '#94a3b8', background: 'rgba(255,255,255,.85)', padding: '2px 8px', borderRadius: 6 }}>
        {sheet.instances.length} 实例 · {sheet.wires.length} 连线 · 拖拽平移 / 滚轮缩放
      </div>
    </div>
  );
}

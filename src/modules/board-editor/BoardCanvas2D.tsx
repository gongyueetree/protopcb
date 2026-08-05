/**
 * modules/board-editor/BoardCanvas2D.tsx
 * 2D 画布：渲染板框 + 器件（带丝印），支持拖拽/选中/缩放/平移。
 * 坐标系：板坐标(mm) → 像素用 PX_PER_MM。
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import { useDesignStore } from '../../state/designStore';
import { PX_PER_MM, footprintBodyRect } from '../../design-core/geometry';
import { padFootprintFor } from '../../design-core/geometry/footprint-pads';
import { mountingHoleCenters, HOLE_DIAMETER_MM } from '../../design-core/collision';
import { CATEGORY_DISPLAY } from '../../shared/theme';
import type { PlacedComponent } from '../../design-core/document/types';

const ORIGIN = { x: 60, y: 40 }; // 板框左上角在 svg 中的像素偏移

/** 视图状态持久化（切换 2D/3D 再回来不丢位置） */
const viewMemory = { zoom: 1, pan: { x: 0, y: 0 } };

export function BoardCanvas2D() {
  const doc = useDesignStore((s) => s.doc);
  const selectedId = useDesignStore((s) => s.selectedId);
  const multiSel = useDesignStore((s) => s.multiSel);
  const overlaps = useDesignStore((s) => s.overlaps);
  const activeLayer = useDesignStore((s) => s.activeLayer);
  const hideAllRefDes = useDesignStore((s) => s.hideAllRefDes);
  const select = useDesignStore((s) => s.select);
  const toggleMulti = useDesignStore((s) => s.toggleMulti);
  const move = useDesignStore((s) => s.moveComponent);
  const moveRefDes = useDesignStore((s) => s.moveRefDes);

  const [zoom, setZoomRaw] = useState(viewMemory.zoom);
  const [pan, setPanRaw] = useState(viewMemory.pan);
  const setZoom = (v: number | ((p: number) => number)) => setZoomRaw((p) => { const n = typeof v === 'function' ? v(p) : v; viewMemory.zoom = n; return n; });
  const setPan = (v: { x: number; y: number } | ((p: { x: number; y: number }) => { x: number; y: number })) => setPanRaw((p) => { const n = typeof v === 'function' ? v(p) : v; viewMemory.pan = n; return n; });
  const containerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef({ active: false, sx: 0, sy: 0, px: 0, py: 0, moved: false });
  const dragRef = useRef({ active: false, id: '', sx: 0, sy: 0, startX: 0, startY: 0, mode: 'comp' as 'comp' | 'refdes' });

  const bw = doc.board.widthMm * PX_PER_MM;
  const bh = doc.board.heightMm * PX_PER_MM;

  // wheel zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom((prev) => {
        const next = Math.min(5, Math.max(0.2, prev * delta));
        setPan((p) => ({ x: mx - (mx - p.x) * (next / prev), y: my - (my - p.y) * (next / prev) }));
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // global mouse for drag/pan
  useEffect(() => {
    const onMM = (e: MouseEvent) => {
      if (dragRef.current.active) {
        const d = dragRef.current;
        const dxMm = (e.clientX - d.sx) / zoom / PX_PER_MM;
        const dyMm = (e.clientY - d.sy) / zoom / PX_PER_MM;
        if (d.mode === 'refdes') moveRefDes(d.id, d.startX + dxMm, d.startY + dyMm);
        else move(d.id, d.startX + dxMm, d.startY + dyMm);
      } else if (panRef.current.active) {
        const dx = e.clientX - panRef.current.sx, dy = e.clientY - panRef.current.sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panRef.current.moved = true;
        setPan({ x: panRef.current.px + dx, y: panRef.current.py + dy });
      }
    };
    const onMU = () => { dragRef.current.active = false; panRef.current.active = false; };
    window.addEventListener('mousemove', onMM);
    window.addEventListener('mouseup', onMU);
    return () => { window.removeEventListener('mousemove', onMM); window.removeEventListener('mouseup', onMU); };
  }, [zoom, move, moveRefDes]);

  const onCompDown = useCallback((e: React.MouseEvent, c: PlacedComponent) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) { toggleMulti(c.instanceId); return; }
    select(c.instanceId);
    dragRef.current = { active: true, id: c.instanceId, sx: e.clientX, sy: e.clientY, startX: c.placement.xMm, startY: c.placement.yMm, mode: 'comp' };
  }, [select, toggleMulti]);

  const onRefDesDown = useCallback((e: React.MouseEvent, c: PlacedComponent) => {
    e.stopPropagation();
    const cur = c.refDesDisplay ?? { dx: 0, dy: 0, rotation: 0, hidden: false };
    dragRef.current = { active: true, id: c.instanceId, sx: e.clientX, sy: e.clientY, startX: cur.dx, startY: cur.dy, mode: 'refdes' };
  }, []);

  const onBgDown = (e: React.MouseEvent) => {
    if (e.button === 0) panRef.current = { active: true, sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, moved: false };
  };
  const onBgClick = () => { if (!panRef.current.moved) select(null); };

  return (
    <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#F8F9FA' }}>
      <svg width="100%" height="100%" onMouseDown={onBgDown} onClick={onBgClick}>
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0L0 0 0 20" fill="none" stroke="#e5e7eb" strokeWidth=".5" /></pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          <BoardOutline shape={doc.board.shape} x={ORIGIN.x} y={ORIGIN.y} w={bw} h={bh} />
          {/* 定位孔 */}
          {mountingHoleCenters(doc.board).map((c, i) => (
            <g key={i}>
              <circle cx={ORIGIN.x + c.x * PX_PER_MM} cy={ORIGIN.y + c.y * PX_PER_MM} r={HOLE_DIAMETER_MM / 2 * PX_PER_MM} fill="#cbd5e1" stroke="#64748b" strokeWidth={1} />
              <circle cx={ORIGIN.x + c.x * PX_PER_MM} cy={ORIGIN.y + c.y * PX_PER_MM} r={HOLE_DIAMETER_MM / 2 * PX_PER_MM - 2} fill="#F8F9FA" />
            </g>
          ))}
          <text x={ORIGIN.x + bw / 2} y={ORIGIN.y - 8} textAnchor="middle" fontSize={10} fontFamily="monospace" fill="#6b7280">
            {doc.board.widthMm}mm × {doc.board.heightMm}mm
          </text>
          {doc.components.map((c) => (
            <ComponentGlyph key={c.instanceId} comp={c}
              selected={selectedId === c.instanceId}
              multi={multiSel.includes(c.instanceId)}
              overlap={overlaps.has(c.instanceId)}
              inactive={c.placement.side !== activeLayer}
              hideRefDes={hideAllRefDes || !!c.refDesDisplay?.hidden}
              onMouseDown={(e) => onCompDown(e, c)}
              onRefDesDown={(e) => onRefDesDown(e, c)} />
          ))}
          {doc.components.length === 0 && (
            <text x={ORIGIN.x + bw / 2} y={ORIGIN.y + bh / 2} textAnchor="middle" fontSize={12} fill="#94a3b8">从左侧添加器件，自动按电气规则摆放</text>
          )}
        </g>
      </svg>
      <div style={{ position: 'absolute', bottom: 12, right: 12, display: 'flex', gap: 4, alignItems: 'center', background: 'rgba(255,255,255,.92)', borderRadius: 8, padding: '4px 6px', border: '1px solid #e2e8f0', fontSize: 11 }}>
        <button onClick={() => setZoom((z) => Math.max(0.2, z * 0.8))} style={zbtn}>−</button>
        <span onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={{ minWidth: 42, textAlign: 'center', fontWeight: 600, cursor: 'pointer' }}>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(5, z * 1.25))} style={zbtn}>+</button>
      </div>
    </div>
  );
}

const zbtn: React.CSSProperties = { width: 24, height: 24, border: '1px solid #e2e8f0', borderRadius: 4, background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 700, color: '#475569' };

function BoardOutline({ shape, x, y, w, h }: { shape: string; x: number; y: number; w: number; h: number }) {
  const fill = '#f8fdf9', stroke = '#2D5F3F';
  if (shape === 'circle') {
    const r = Math.min(w, h) / 2;
    return <circle cx={x + w / 2} cy={y + h / 2} r={r} fill={fill} stroke={stroke} strokeWidth={2} />;
  }
  if (shape === 'lshape') {
    const cutW = w * 0.45, cutH = h * 0.4;
    return <path d={`M${x},${y} H${x + w} V${y + h - cutH} H${x + w - cutW} V${y + h} H${x} Z`} fill={fill} stroke={stroke} strokeWidth={2} />;
  }
  return <rect x={x} y={y} width={w} height={h} rx={shape === 'rounded' ? 18 : 6} fill={fill} stroke={stroke} strokeWidth={2} />;
}

function ComponentGlyph({ comp, selected, multi, overlap, inactive, hideRefDes, onMouseDown, onRefDesDown }: {
  comp: PlacedComponent; selected: boolean; multi: boolean; overlap: boolean; inactive: boolean; hideRefDes: boolean;
  onMouseDown: (e: React.MouseEvent) => void; onRefDesDown: (e: React.MouseEvent) => void;
}) {
  const disp = CATEGORY_DISPLAY[comp.category];
  const pads = padFootprintFor(comp.footprint.name);
  const isBottom = comp.placement.side === 'BOTTOM';
  // 中心点（px）
  const cx = ORIGIN.x + comp.placement.xMm * PX_PER_MM;
  const cy = ORIGIN.y + comp.placement.yMm * PX_PER_MM;
  const rot = comp.placement.rotation;
  const courtyard = footprintBodyRect(comp.footprint.geometry, { x: comp.placement.xMm, y: comp.placement.yMm }, comp.placement.rotation);
  const rd = comp.refDesDisplay ?? { dx: 0, dy: 0, rotation: 0, hidden: false };

  if (pads) {
    // Bottom 层：铜色→蓝色系、水平镜像
    const copper = isBottom ? '#3b82c4' : '#c08a2d';
    const copperStroke = isBottom ? '#1d4e8a' : '#8a6420';
    const bodyStroke = overlap ? '#ef4444' : selected ? '#2563eb' : isBottom ? '#3b82c4' : disp.color;
    const halfW = (Math.max(...pads.pads.map((p) => Math.abs(p.x) + p.w / 2), pads.bodyW / 2)) * PX_PER_MM;
    const halfH = (Math.max(...pads.pads.map((p) => Math.abs(p.y) + p.h / 2), pads.bodyH / 2)) * PX_PER_MM;
    return (
      <g transform={`translate(${cx},${cy}) rotate(${rot})${isBottom ? ' scale(-1,1)' : ''}`} opacity={inactive ? 0.35 : 1}
        onMouseDown={onMouseDown} onClick={(e) => e.stopPropagation()} style={{ cursor: 'grab' }}>
        {(selected || multi) && <rect x={-halfW - 4} y={-halfH - 4} width={halfW * 2 + 8} height={halfH * 2 + 8} rx={3} fill="none" stroke={multi ? '#f59e0b' : '#2563eb'} strokeWidth={1.5} strokeDasharray="5 3" />}
        <rect x={-pads.bodyW * PX_PER_MM / 2} y={-pads.bodyH * PX_PER_MM / 2} width={pads.bodyW * PX_PER_MM} height={pads.bodyH * PX_PER_MM} rx={2}
          fill={overlap ? 'rgba(239,68,68,.06)' : 'rgba(148,163,184,.08)'} stroke={bodyStroke} strokeWidth={selected ? 1.4 : 0.9} />
        {pads.pads.map((p, i) => (
          <rect key={i} x={(p.x - p.w / 2) * PX_PER_MM} y={(p.y - p.h / 2) * PX_PER_MM} width={p.w * PX_PER_MM} height={p.h * PX_PER_MM}
            rx={p.round ? p.w * PX_PER_MM / 2 : 0.8} fill={copper} stroke={copperStroke} strokeWidth={0.3} />
        ))}
        {pads.pin1 && <circle cx={pads.pin1.x * PX_PER_MM} cy={pads.pin1.y * PX_PER_MM} r={1.6} fill="#dc2626" />}
        {/* 位号：可拖动、可隐藏 */}
        {!hideRefDes && (
          <g transform={`${isBottom ? 'scale(-1,1) ' : ''}rotate(${-rot})`}>
            <text x={rd.dx * PX_PER_MM} y={-halfH - 6 + rd.dy * PX_PER_MM} textAnchor="middle" fontSize={8} fontFamily="monospace" fontWeight={700}
              fill={isBottom ? '#3b82c4' : disp.color} style={{ cursor: 'move' }}
              onMouseDown={onRefDesDown}>{comp.reference}</text>
          </g>
        )}
      </g>
    );
  }

  // 兜底：无焊盘数据时画方块（保持旧行为）
  const px = ORIGIN.x + courtyard.x * PX_PER_MM;
  const py = ORIGIN.y + courtyard.y * PX_PER_MM;
  const pw = Math.max(20, courtyard.width * PX_PER_MM), ph = Math.max(14, courtyard.height * PX_PER_MM);
  const stroke = overlap ? '#ef4444' : selected ? '#2563eb' : '#94a3b8';
  return (
    <g transform={`translate(${px},${py})`} onMouseDown={onMouseDown} onClick={(e) => e.stopPropagation()} style={{ cursor: 'grab' }}>
      {multi && <rect x={-5} y={-5} width={pw + 10} height={ph + 10} rx={4} fill="none" stroke="#f59e0b" strokeWidth={2} strokeDasharray="6 3" />}
      <rect width={pw} height={ph} rx={3} fill={overlap ? '#fff5f5' : '#fff'} stroke={stroke} strokeWidth={selected || overlap ? 2 : 1} />
      <text x={pw / 2} y={-5} textAnchor="middle" fontSize={8} fontFamily="monospace" fontWeight={700} fill={disp.color}>{comp.reference}</text>
      <text x={pw / 2} y={ph / 2} textAnchor="middle" dominantBaseline="middle" fontSize={pw > 60 ? 8 : 6.5} fontFamily="monospace" fontWeight={700} fill="#1e293b">{comp.mpn.length > 14 ? comp.mpn.slice(0, 12) + '..' : comp.mpn}</text>
      <text x={pw / 2} y={ph / 2 + 10} textAnchor="middle" fontSize={6} fontFamily="monospace" fill="#94a3b8">{comp.footprint.name}</text>
    </g>
  );
}

export { ORIGIN };

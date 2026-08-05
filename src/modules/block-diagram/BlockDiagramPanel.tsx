/**
 * modules/block-diagram/BlockDiagramPanel.tsx
 * 系统框图编辑器 —— 拖拽/调整大小/改形状/连线/缩放平移/全屏。
 * 数据存于 store 的 functionalBlocks + connections。
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import { useDesignStore } from '../../state/designStore';
import { BD_SHAPES, BdShape } from './shapes';
import type { FunctionalBlock, LogicalConnection } from '../../design-core/document/types';
import { COLORS } from '../../shared/theme';

export function BlockDiagramPanel({ isFullscreen, onToggleFullscreen }: { isFullscreen?: boolean; onToggleFullscreen?: () => void }) {
  const blocks = useDesignStore((s) => s.doc.functionalBlocks);
  const conns = useDesignStore((s) => s.doc.connections);
  const setBlocks = useDesignStore((s) => s.setFunctionalBlocks);
  const setConns = useDesignStore((s) => s.setConnections);
  const regen = useDesignStore((s) => s.generateBlocksFromComponents);
  const hasComps = useDesignStore((s) => s.doc.components.length > 0);
  // 核心器件（非无源）签名：增删器件时自动同步框图（保留用户布局与自定义块）
  const coreSig = useDesignStore((s) => s.doc.components.filter((c) => c.category !== 'passive').map((c) => c.instanceId).sort().join(','));

  const [sel, setSel] = useState<{ type: 'node' | 'arrow'; id: string } | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef({ active: false, id: '', sx: 0, sy: 0, startX: 0, startY: 0 });
  const resizeRef = useRef({ active: false, id: '', handle: '', sx: 0, sy: 0, ox: 0, oy: 0, ow: 0, oh: 0 });
  const panRef = useRef({ active: false, sx: 0, sy: 0, px: 0, py: 0, moved: false });
  const labelDragRef = useRef({ active: false, id: '', sx: 0, sy: 0, dx: 0, dy: 0 });

  // first generate
  useEffect(() => { if (hasComps || blocks.length > 0) regen(); }, [coreSig]);

  // wheel zoom
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom((prev) => {
        const next = Math.min(4, Math.max(0.3, prev * delta));
        setPan((p) => ({ x: mx - (mx - p.x) * (next / prev), y: my - (my - p.y) * (next / prev) }));
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // global mouse
  useEffect(() => {
    const onMM = (e: MouseEvent) => {
      if (labelDragRef.current.active) {
        const d = labelDragRef.current;
        setConns(conns.map((c) => c.id === d.id ? { ...c, labelDx: d.dx + (e.clientX - d.sx) / zoom, labelDy: d.dy + (e.clientY - d.sy) / zoom } : c));
        return;
      }
      if (resizeRef.current.active) {
        const r = resizeRef.current;
        const dx = (e.clientX - r.sx) / zoom, dy = (e.clientY - r.sy) / zoom;
        setBlocks(blocks.map((n) => {
          if (n.id !== r.id) return n;
          let { x, y, w, h } = { x: r.ox, y: r.oy, w: r.ow, h: r.oh };
          if (r.handle.includes('e')) w = Math.max(60, r.ow + dx);
          if (r.handle.includes('s')) h = Math.max(36, r.oh + dy);
          if (r.handle.includes('w')) { const nw = Math.max(60, r.ow - dx); x = r.ox + r.ow - nw; w = nw; }
          if (r.handle.includes('n')) { const nh = Math.max(36, r.oh - dy); y = r.oy + r.oh - nh; h = nh; }
          return { ...n, x, y, w, h };
        }));
        return;
      }
      if (dragRef.current.active) {
        const d = dragRef.current;
        setBlocks(blocks.map((n) => n.id === d.id ? { ...n, x: Math.max(0, d.startX + (e.clientX - d.sx) / zoom), y: Math.max(0, d.startY + (e.clientY - d.sy) / zoom) } : n));
        return;
      }
      if (panRef.current.active) {
        const dx = e.clientX - panRef.current.sx, dy = e.clientY - panRef.current.sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panRef.current.moved = true;
        setPan({ x: panRef.current.px + dx, y: panRef.current.py + dy });
      }
    };
    const onMU = () => { dragRef.current.active = false; resizeRef.current.active = false; panRef.current.active = false; labelDragRef.current.active = false; };
    window.addEventListener('mousemove', onMM);
    window.addEventListener('mouseup', onMU);
    return () => { window.removeEventListener('mousemove', onMM); window.removeEventListener('mouseup', onMU); };
  }, [blocks, conns, zoom, setBlocks, setConns]);

  const onNodeDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (connecting) {
      if (connecting !== id && !conns.some((c) => c.fromId === connecting && c.toId === id)) {
        setConns([...conns, { id: `c_${Date.now()}`, fromId: connecting, toId: id, label: 'NET', style: 'single' }]);
      }
      setConnecting(null);
      return;
    }
    const n = blocks.find((b) => b.id === id);
    if (!n) return;
    dragRef.current = { active: true, id, sx: e.clientX, sy: e.clientY, startX: n.x, startY: n.y };
    setSel({ type: 'node', id });
  };

  const startResize = (e: React.MouseEvent, id: string, handle: string) => {
    e.stopPropagation();
    const n = blocks.find((b) => b.id === id);
    if (!n) return;
    resizeRef.current = { active: true, id, handle, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, ow: n.w, oh: n.h };
  };

  const addNode = () => {
    const c = ['#1a6b3c', '#b45309', '#0e7490', '#6d28d9'][blocks.length % 4];
    setBlocks([...blocks, { id: `blk_${Date.now()}`, label: '新模块', sublabel: '', shape: 'rounded', x: 60 + Math.random() * 150, y: 40 + Math.random() * 80, w: 140, h: 64, color: c }]);
  };

  const del = () => {
    if (!sel) return;
    if (sel.type === 'node') { setBlocks(blocks.filter((n) => n.id !== sel.id)); setConns(conns.filter((c) => c.fromId !== sel.id && c.toId !== sel.id)); }
    else setConns(conns.filter((c) => c.id !== sel.id));
    setSel(null);
  };

  const changeShape = (shape: string) => { if (sel?.type === 'node') setBlocks(blocks.map((n) => n.id === sel.id ? { ...n, shape } : n)); };

  const nc = (id: string) => { const n = blocks.find((b) => b.id === id); return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : { x: 0, y: 0 }; };
  // 框边缘交点：从框中心朝目标方向，求与矩形边框的交点
  const edgePoint = (id: string, toward: { x: number; y: number }) => {
    const n = blocks.find((b) => b.id === id);
    if (!n) return { x: 0, y: 0 };
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    const dx = toward.x - cx, dy = toward.y - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const hw = n.w / 2, hh = n.h / 2;
    // 计算射线与矩形边的最近交点
    const scaleX = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    const scaleY = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY);
    return { x: cx + dx * scale, y: cy + dy * scale };
  };

  const fitView = () => {
    if (blocks.length === 0) return;
    const el = svgRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const minX = Math.min(...blocks.map((b) => b.x)), minY = Math.min(...blocks.map((b) => b.y));
    const maxX = Math.max(...blocks.map((b) => b.x + b.w)), maxY = Math.max(...blocks.map((b) => b.y + b.h));
    const z = Math.min((rect.width - 100) / (maxX - minX), (rect.height - 100) / (maxY - minY), 2);
    setZoom(z);
    setPan({ x: rect.width / 2 - ((minX + maxX) / 2) * z, y: rect.height / 2 - ((minY + maxY) / 2) * z });
  };

  const finishEdit = () => { if (editId) setBlocks(blocks.map((n) => n.id === editId ? { ...n, label: editText } : n)); setEditId(null); };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 12, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>📊 系统框图</span>
        <button onClick={addNode} style={tb}>+ 模块</button>
        <button onClick={() => setConnecting(connecting ? null : '__pick__')} style={{ ...tb, ...(connecting ? { background: '#f0fdf4', color: '#16a34a', borderColor: '#22c55e' } : {}) }}>{connecting ? '✕ 取消连线' : '+ 连线'}</button>
        <button onClick={del} disabled={!sel} style={{ ...tb, opacity: sel ? 1 : 0.5 }}>🗑 删除</button>
        <button onClick={regen} style={tb}>🔄 重新生成</button>
        <button onClick={fitView} style={tb}>⊡ 适应</button>
        <button onClick={() => {
          const svg = svgRef.current; if (!svg) return;
          const clone = svg.cloneNode(true) as SVGSVGElement;
          clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + clone.outerHTML], { type: 'image/svg+xml' });
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'block-diagram.svg'; a.click(); URL.revokeObjectURL(a.href);
        }} style={tb}>⬇ 导出SVG</button>
        {sel?.type === 'node' && (
          <>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>形状:</span>
            {BD_SHAPES.map((s) => (
              <button key={s.id} title={s.name} onClick={() => changeShape(s.id)} style={{ width: 24, height: 22, borderRadius: 4, border: '1px solid #E8F3EE', background: '#fff', cursor: 'pointer', fontSize: 12 }}>{s.icon}</button>
            ))}
          </>
        )}
        {connecting && <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700 }}>{connecting === '__pick__' ? '① 点击起点模块' : '② 点击目标模块完成连线'}</span>}
        {sel?.type === 'arrow' && (() => {
          const a = conns.find((c) => c.id === sel.id);
          if (!a) return null;
          const styles: [string, string][] = [['single', '→单向'], ['double', '↔双向'], ['bus', '≡总线'], ['none', '—无箭头']];
          return (
            <>
              <div style={{ width: 1, height: 14, background: '#E8F3EE' }} />
              {styles.map(([st, label]) => (
                <button key={st} onClick={() => setConns(conns.map((c) => c.id === sel.id ? { ...c, style: st as typeof c.style } : c))}
                  style={{ ...tb, ...(a.style === st ? { borderColor: '#22c55e', color: '#16a34a', background: '#f0fdf4' } : {}) }}>{label}</button>
              ))}
              <button onClick={() => setConns(conns.map((c) => c.id === sel.id ? { ...c, fromId: c.toId, toId: c.fromId } : c))} style={tb}>⇄ 反向</button>
              <button onClick={() => setConns(conns.map((c) => c.id === sel.id ? { ...c, labelRot: ((c.labelRot ?? 0) + 90) % 360 } : c))} style={tb}>⟳ 转标签</button>
            </>
          );
        })()}
        <div style={{ flex: 1 }} />
        {onToggleFullscreen && <button onClick={onToggleFullscreen} style={tb}>{isFullscreen ? '↙ 退出全屏' : '⛶ 全屏'}</button>}
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fafbfc' }}>
        <svg ref={svgRef} width="100%" height="100%"
          onMouseDown={(e) => { if (e.button === 0 && !connecting) panRef.current = { active: true, sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, moved: false }; }}
          onClick={() => { if (!panRef.current.moved) setSel(null); }}>
          <defs>
            <marker id="bdarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1L8 5L0 9z" fill="#64748b" /></marker>
          </defs>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {conns.map((a) => {
              const fc = nc(a.fromId), tc = nc(a.toId);
              const f = edgePoint(a.fromId, tc), t = edgePoint(a.toId, fc);
              const isSel = sel?.type === 'arrow' && sel.id === a.id;
              const mx = (f.x + t.x) / 2 + (a.labelDx ?? 0), my = (f.y + t.y) / 2 - 4 + (a.labelDy ?? 0);
              const sw = a.style === 'bus' ? 4 : isSel ? 2.2 : 1.5;
              return (
                <g key={a.id}>
                  <line x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke="transparent" strokeWidth={12} style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setSel({ type: 'arrow', id: a.id }); }} />
                  <line x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke={isSel ? '#2563eb' : a.style === 'bus' ? '#475569' : '#64748b'} strokeWidth={sw}
                    markerEnd={a.style === 'none' || a.style === 'bus' ? undefined : 'url(#bdarrow)'}
                    markerStart={a.style === 'double' ? 'url(#bdarrow)' : undefined}
                    style={{ pointerEvents: 'none' }} />
                  {a.label && (
                    <text x={mx} y={my} transform={a.labelRot ? `rotate(${a.labelRot} ${mx} ${my})` : undefined}
                      textAnchor="middle" fontSize={9} fontWeight={700} fill={isSel ? '#2563eb' : '#64748b'} style={{ cursor: 'move' }}
                      onMouseDown={(e) => { e.stopPropagation(); labelDragRef.current = { active: true, id: a.id, sx: e.clientX, sy: e.clientY, dx: a.labelDx ?? 0, dy: a.labelDy ?? 0 }; }}
                      onClick={(e) => { e.stopPropagation(); setSel({ type: 'arrow', id: a.id }); }}>{a.label}</text>
                  )}
                </g>
              );
            })}
            {blocks.map((n) => (
              <BlockNode key={n.id} node={n} selected={sel?.type === 'node' && sel.id === n.id} connecting={!!connecting} isSource={connecting === n.id}
                onDown={(e) => { if (connecting === '__pick__') { e.stopPropagation(); setConnecting(n.id); return; } onNodeDown(e, n.id); }}
                onResize={startResize}
                editing={editId === n.id} editText={editText} setEditText={setEditText} finishEdit={finishEdit}
                onDouble={() => { setEditId(n.id); setEditText(n.label); }} />
            ))}
          </g>
        </svg>
        <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', gap: 4, alignItems: 'center', background: 'rgba(255,255,255,.92)', borderRadius: 6, padding: '3px 5px', border: '1px solid #e2e8f0', fontSize: 10 }}>
          <button onClick={() => setZoom((z) => Math.max(0.3, z * 0.8))} style={zb}>−</button>
          <span onClick={fitView} style={{ minWidth: 34, textAlign: 'center', fontWeight: 600, cursor: 'pointer' }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(4, z * 1.25))} style={zb}>+</button>
        </div>
        {blocks.length === 0 && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>添加器件后自动生成框图，或点「+ 模块」手动创建</div>}
      </div>
    </div>
  );
}

function BlockNode({ node, selected, connecting, isSource, onDown, onResize, editing, editText, setEditText, finishEdit, onDouble }: {
  node: FunctionalBlock; selected: boolean; connecting: boolean; isSource?: boolean;
  onDown: (e: React.MouseEvent) => void; onResize: (e: React.MouseEvent, id: string, handle: string) => void;
  editing: boolean; editText: string; setEditText: (s: string) => void; finishEdit: () => void; onDouble: () => void;
}) {
  const handles = [
    { h: 'nw', x: 0, y: 0, c: 'nwse-resize' }, { h: 'ne', x: node.w, y: 0, c: 'nesw-resize' },
    { h: 'sw', x: 0, y: node.h, c: 'nesw-resize' }, { h: 'se', x: node.w, y: node.h, c: 'nwse-resize' },
  ];
  return (
    <g transform={`translate(${node.x},${node.y})`} onMouseDown={onDown} onClick={(e) => e.stopPropagation()} onDoubleClick={onDouble} style={{ cursor: connecting ? 'pointer' : 'grab' }}>
      <BdShape shape={node.shape} x={0} y={0} w={node.w} h={node.h} fill={node.color} fillOpacity={isSource ? 0.3 : 0.12} stroke={isSource ? '#16a34a' : node.color} strokeWidth={selected || isSource ? 2.5 : 1.8} />
      {editing ? (
        <foreignObject x={6} y={node.h / 2 - 12} width={node.w - 12} height={24}>
          <input autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} onBlur={finishEdit}
            onKeyDown={(e) => { if (e.key === 'Enter') finishEdit(); e.stopPropagation(); }}
            style={{ width: '100%', fontSize: 12, fontWeight: 700, textAlign: 'center', border: '1px solid #93c5fd', borderRadius: 4, outline: 'none', boxSizing: 'border-box' }} />
        </foreignObject>
      ) : (
        <text x={node.w / 2} y={node.h / 2} textAnchor="middle" dominantBaseline="middle" fontSize={12} fontWeight={700} fill={node.color} style={{ pointerEvents: 'none' }}>{node.label}</text>
      )}
      {node.sublabel && !editing && <text x={node.w / 2} y={node.h / 2 + 16} textAnchor="middle" fontSize={8} fill="#94a3b8" style={{ pointerEvents: 'none' }}>{node.sublabel}</text>}
      {selected && handles.map((hd) => (
        <rect key={hd.h} x={hd.x - 4} y={hd.y - 4} width={8} height={8} fill="#fff" stroke="#2563eb" strokeWidth={1.5} style={{ cursor: hd.c }} onMouseDown={(e) => { e.stopPropagation(); onResize(e, node.id, hd.h); }} />
      ))}
    </g>
  );
}

const tb: React.CSSProperties = { padding: '4px 10px', borderRadius: 5, border: '1px solid #E8F3EE', background: '#fff', color: '#475569', fontSize: 11, fontWeight: 600, cursor: 'pointer' };
const zb: React.CSSProperties = { width: 20, height: 20, border: '1px solid #e2e8f0', borderRadius: 3, background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#475569' };

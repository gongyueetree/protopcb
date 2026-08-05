/**
 * modules/schematic/SchematicPanel.tsx
 * 原理图 —— 自动生成 + 可编辑。状态存于 schematicStore（全屏/非全屏共享，不丢失）。
 * 交互：拖符号移动 · R 旋转 · D/Delete 删除选中连线 · 双击位号/值编辑 · 滚轮缩放 · 导出SVG。
 */
import { tr } from '../../shared/i18n';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useDesignStore } from '../../state/designStore';
import { useSchematicStore, type SchNet } from './schematicStore';
import { symbolFor, symbolUnitsFor } from './symbols';
import { useLibFileStore } from '../../design-core/geometry/lib-file-registry';
import { ImportedSchematicView } from './ImportedSchematicView';
import { isCore, signalFlowRank } from '../../design-core/placement/affinity';
import type { PlacedComponent } from '../../design-core/document/types';

let netCounter = 0;
const nid = () => `net_${++netCounter}_${Date.now()}`;

export function SchematicPanel({ isFullscreen, onToggleFullscreen }: { isFullscreen?: boolean; onToggleFullscreen?: () => void }) {
  const sheet = useDesignStore((st) => st.doc.schematicSheet);
  const [schView, setSchView] = useState<'imported' | 'auto'>('imported');
  const items = useDesignStore((s) => s.doc.components);
  const pos = useSchematicStore((s) => s.pos);
  const nets = useSchematicStore((s) => s.nets);
  const zoom = useSchematicStore((s) => s.zoom);
  const pan = useSchematicStore((s) => s.pan);
  const setPos = useSchematicStore((s) => s.setPos);
  const setNets = useSchematicStore((s) => s.setNets);
  const setZoom = useSchematicStore((s) => s.setZoom);
  const setPan = useSchematicStore((s) => s.setPan);
  const resetSch = useSchematicStore((s) => s.reset);

  const [sel, setSel] = useState<string | null>(null); // net id
  const [selSym, setSelSym] = useState<string | null>(null); // component instanceId
  const [linking, setLinking] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ type: 'netlabel' | 'refdes' | 'value'; id: string; text: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, iid: '', sx: 0, sy: 0, startX: 0, startY: 0 });
  const netDragRef = useRef({ active: false, id: '', sx: 0, dx: 0 });
  const panRef = useRef({ active: false, sx: 0, sy: 0, px: 0, py: 0, moved: false });

  const libVersion = useLibFileStore((st) => st.version);
  /** 多单元展开：LM358 → [U4A 运放, U4B 运放, U4C 电源]，各自独立摆放/移动 */
  const unitEntries = useMemo(() => items.flatMap((c) => {
    const units = symbolUnitsFor(c);
    return units.map((sym, k) => ({
      key: k === 0 ? c.instanceId : `${c.instanceId}#u${k + 1}`,
      c, sym,
      suffix: units.length > 1 ? String.fromCharCode(65 + k) : '',
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [items, libVersion]);
  const entryOf = useCallback((key: string) => unitEntries.find((e) => e.key === key), [unitEntries]);

  const autoLayout = useMemo(() => {
    const out: Record<string, { x: number; y: number }> = {};
    // ── 核心按信号流分列：输入接口 → 电源 → 主控 → 外设IC → 输出接口 ──
    const coreEntries = unitEntries.filter((e) => isCore(e.c));
    const auxEntries = unitEntries.filter((e) => !isCore(e.c));
    const rankOf = (e: (typeof unitEntries)[number]) => signalFlowRank({ reference: e.c.reference, category: e.c.category, mpn: e.c.mpn, description: e.c.display?.description });
    const byRank: Record<number, typeof unitEntries> = {};
    coreEntries.forEach((e) => { const r = rankOf(e); (byRank[r] = byRank[r] || []).push(e); });
    const ranks = Object.keys(byRank).map(Number).sort((a, b) => a - b);
    const corePos: Record<string, { x: number; y: number }> = {}; // reference → 位置
    ranks.forEach((r, col) => {
      byRank[r].forEach((e, row) => {
        const p2 = { x: 50 + col * 260, y: 40 + row * 220 };
        out[e.key] = p2;
        corePos[e.c.reference] = p2;
      });
    });
    // ── 辅件跟随所属核心：核心正下方 3 列小网格；无归属的进末尾杂项区 ──
    const grouped: Record<string, typeof unitEntries> = {};
    const orphans: typeof unitEntries = [];
    auxEntries.forEach((e) => {
      const coreRef = e.c.display?.anchorRef;
      if (coreRef && corePos[coreRef]) (grouped[coreRef] = grouped[coreRef] || []).push(e);
      else orphans.push(e);
    });
    Object.entries(grouped).forEach(([coreRef, list]) => {
      const cp = corePos[coreRef];
      list.forEach((e, i) => {
        out[e.key] = { x: cp.x + (i % 3) * 75, y: cp.y + 130 + Math.floor(i / 3) * 65 };
      });
    });
    const miscX = 50 + ranks.length * 260;
    orphans.forEach((e, i) => { out[e.key] = { x: miscX + (i % 2) * 80, y: 40 + Math.floor(i / 2) * 65 }; });
    return out;
  }, [unitEntries]);

  const P = useCallback((iid: string) => {
    const st = pos[iid];
    const base = autoLayout[iid] || { x: 100, y: 100 };
    return { x: st?.x ?? base.x, y: st?.y ?? base.y, rotation: st?.rotation ?? 0 };
  }, [pos, autoLayout]);

  const refOf = (c: PlacedComponent) => pos[c.instanceId]?.refDes ?? c.reference;
  const valOf = (c: PlacedComponent) => pos[c.instanceId]?.value ?? c.mpn;


  /** 符号端口的世界坐标（含旋转）；返回 [引脚桩末端点, 端口点] */
  const worldPorts = useCallback((iid: string) => {
    const e = entryOf(iid);
    if (!e) return [];
    const sym = e.sym;
    const p = P(iid);
    const cx = sym.w / 2, cy = sym.h / 2;
    const th = ((p.rotation % 360) + 360) % 360;
    const cos = th === 0 ? 1 : th === 180 ? -1 : 0;
    const sin = th === 90 ? 1 : th === 270 ? -1 : 0;
    const stub = sym.stubLen ?? 10;
    return sym.ports.map((pt) => {
      // 引脚桩向外方向（局部）；无源符号 stub=0，端点即图形末端
      const nx = pt.x <= 0 ? -1 : pt.x >= sym.w ? 1 : 0;
      const ny = nx !== 0 ? 0 : pt.y >= sym.h ? 1 : -1;
      const rot = (lx: number, ly: number) => ({ x: cx + (lx - cx) * cos - (ly - cy) * sin, y: cy + (lx - cx) * sin + (ly - cy) * cos });
      const port = rot(pt.x, pt.y);
      const tip = rot(pt.x + nx * stub, pt.y + ny * stub);
      return { tip: { x: p.x + tip.x, y: p.y + tip.y }, port: { x: p.x + port.x, y: p.y + port.y } };
    });
  }, [entryOf, P]);

  const genNets = useCallback((): SchNet[] => {
    const out: SchNet[] = [];
    const by = (cat: string) => items.filter((i) => i.category === cat);
    const mcus = by('mcu'), powers = by('power'), conns = by('connector'), ics = by('ic'), passives = by('passive');
    powers.forEach((p) => [...mcus, ...ics].forEach((t) => out.push({ id: nid(), from: p.instanceId, to: t.instanceId, label: '3V3', color: '#dc2626' })));
    conns.forEach((cn) => (mcus.length ? mcus : ics).forEach((m) => out.push({ id: nid(), from: cn.instanceId, to: m.instanceId, label: cn.display?.family?.includes('USB') ? 'USB' : 'IO', color: '#2563eb' })));
    mcus.forEach((m) => ics.forEach((i) => out.push({ id: nid(), from: m.instanceId, to: i.instanceId, label: i.display?.family?.includes('Flash') ? 'SPI' : 'I2C', color: '#059669' })));
    passives.forEach((pv) => { const t = [...mcus, ...ics][0]; if (t) out.push({ id: nid(), from: pv.instanceId, to: t.instanceId, label: '去耦', color: '#a16207' }); });
    return out;
  }, [items]);

  useEffect(() => { if (nets === null && items.length > 0) setNets(genNets()); }, [items, nets, genNets, setNets]);
  useEffect(() => { if (items.length === 0) resetSch(); }, [items.length, resetSch]);

  // 非被动滚轮缩放（全屏/非全屏都生效）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const cur = useSchematicStore.getState().zoom;
      const next = Math.min(3, Math.max(0.3, cur * (e.deltaY > 0 ? 0.9 : 1.1)));
      const p = useSchematicStore.getState().pan;
      setPan({ x: mx - (mx - p.x) * (next / cur), y: my - (my - p.y) * (next / cur) });
      setZoom(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoom, setPan]);

  // 拖拽 + 平移
  useEffect(() => {
    const onMM = (e: MouseEvent) => {
      if (netDragRef.current.active) {
        const d = netDragRef.current;
        setNets((useSchematicStore.getState().nets || []).map((nn) => nn.id === d.id ? { ...nn, midDx: Math.round((d.dx + (e.clientX - d.sx) / zoom) / 10) * 10 } : nn));
        return;
      }
      if (dragRef.current.active) {
        const d = dragRef.current;
        const nx = Math.round(Math.max(0, d.startX + (e.clientX - d.sx) / zoom) / 10) * 10;
        const ny = Math.round(Math.max(0, d.startY + (e.clientY - d.sy) / zoom) / 10) * 10;
        setPos(d.iid, { x: nx, y: ny });
      } else if (panRef.current.active) {
        const dx = e.clientX - panRef.current.sx, dy = e.clientY - panRef.current.sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panRef.current.moved = true;
        setPan({ x: panRef.current.px + dx, y: panRef.current.py + dy });
      }
    };
    const onMU = () => { dragRef.current.active = false; panRef.current.active = false; netDragRef.current.active = false; };
    window.addEventListener('mousemove', onMM);
    window.addEventListener('mouseup', onMU);
    return () => { window.removeEventListener('mousemove', onMM); window.removeEventListener('mouseup', onMU); };
  }, [zoom, setPos, setPan]);

  // 键盘：R 旋转选中符号，D/Delete 删除选中连线
  // 捕获阶段监听 + stopImmediatePropagation：原理图有选中时优先于 App 全局快捷键（避免 R 被画布器件抢走）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.key === 'r' || e.key === 'R') && selSym) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const cur = P(selSym).rotation;
        setPos(selSym, { rotation: (cur + 90) % 360 });
      }
      if ((e.key === 'd' || e.key === 'D' || e.key === 'Delete') && sel) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setNets((nets || []).filter((n) => n.id !== sel));
        setSel(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selSym, sel, nets, setNets, setPos, P]);

  const onSymDown = (e: React.MouseEvent, iid: string) => {
    e.stopPropagation();
    if (linking === '__pick__') { setLinking(iid); return; }
    if (linking) {
      if (linking !== iid && !(nets || []).some((n) => n.from === linking && n.to === iid)) setNets([...(nets || []), { id: nid(), from: linking, to: iid, label: 'NET', color: '#7c3aed' }]);
      setLinking(null);
      return;
    }
    setSelSym(iid); setSel(null);
    const p = P(iid);
    dragRef.current = { active: true, iid, sx: e.clientX, sy: e.clientY, startX: p.x, startY: p.y };
  };

  const finishEdit = () => {
    if (!edit) return;
    if (edit.type === 'netlabel') setNets((nets || []).map((n) => n.id === edit.id ? { ...n, label: edit.text } : n));
    if (edit.type === 'refdes') setPos(edit.id, { refDes: edit.text });
    if (edit.type === 'value') setPos(edit.id, { value: edit.text });
    setEdit(null);
  };

  const exportSvg = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + clone.outerHTML], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'schematic.svg';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const maxY = Math.max(...unitEntries.map((e) => P(e.key).y), 300);
  const maxX = Math.max(...unitEntries.map((e) => P(e.key).x), 700);
  const W = Math.max(900, maxX + 240), H = Math.max(420, maxY + 160);

  return (
    <div style={{ padding: 12, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>⚡ 原理图</span>
        {sheet && (
          <span style={{ display: 'inline-flex', borderRadius: 7, overflow: 'hidden', border: '1px solid #cbd5e1' }}>
            {([['imported', tr('KiCad 原图')], ['auto', tr('自动生成')]] as const).map(([v, l]) => (
              <button key={v} onClick={() => setSchView(v)}
                style={{ padding: '4px 10px', border: 'none', fontSize: 11, fontWeight: 700, cursor: 'pointer', background: schView === v ? '#1f5c3b' : '#fff', color: schView === v ? '#fff' : '#475569' }}>{l}</button>
            ))}
          </span>
        )}
        <button onClick={() => setLinking(linking ? null : '__pick__')} style={{ ...tb, ...(linking ? { background: '#f0fdf4', color: '#16a34a', borderColor: '#22c55e' } : {}) }}>{linking ? '✕ ' + tr('取消') : '+ ' + tr('连线')}</button>
        <button onClick={() => { if (sel) { setNets((nets || []).filter((n) => n.id !== sel)); setSel(null); } }} disabled={!sel} style={{ ...tb, opacity: sel ? 1 : 0.5 }}>🗑 删除连线(D)</button>
        <button onClick={() => { setNets(genNets()); resetSch(); setSel(null); }} style={tb}>🔄 重新生成</button>
        <button onClick={exportSvg} style={tb}>⬇ 导出SVG</button>
        {selSym && (
          <>
            <div style={{ width: 1, height: 14, background: '#E8F3EE' }} />
            <button onClick={() => { const cur = P(selSym).rotation; setPos(selSym, { rotation: (cur + 90) % 360 }); }} style={{ ...tb, borderColor: '#93c5fd', color: '#2563eb' }}>⟳ 旋转(R)</button>
            <button onClick={() => { const e = entryOf(selSym); if (e) setEdit({ type: 'refdes', id: selSym, text: refOf(e.c) + e.suffix }); }} style={{ ...tb, borderColor: '#93c5fd', color: '#2563eb' }}>✎ 位号</button>
            <button onClick={() => { const e = entryOf(selSym); if (e) setEdit({ type: 'value', id: selSym, text: valOf(e.c) }); }} style={{ ...tb, borderColor: '#93c5fd', color: '#2563eb' }}>✎ 值</button>
          </>
        )}
        <span style={{ fontSize: 10, color: '#94a3b8' }}>拖动符号 · R旋转 · 双击位号/型号编辑 · 滚轮缩放</span>
        <div style={{ flex: 1 }} />
        {onToggleFullscreen && <button onClick={onToggleFullscreen} style={tb}>{isFullscreen ? '↙ 退出全屏' : '⛶ 全屏'}</button>}
      </div>
      {sheet && schView === 'imported' ? <ImportedSchematicView doc={useDesignStore.getState().doc} /> : (<>
      <div ref={wrapRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#fffef9', borderRadius: 8, border: '1px solid #e7e0c9' }}
        onMouseDown={(e) => { if (e.button === 0 && !linking) panRef.current = { active: true, sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, moved: false }; }}
        onClick={() => { if (!panRef.current.moved) { setSel(null); setSelSym(null); if (linking) setLinking(null); } }}>
        <svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMin meet" style={{ minWidth: '100%' }}>
          <defs><pattern id="schg" x="-5" y="-5" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="0.6" fill="#d9d2b8" /></pattern></defs>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          <rect x={-2000} y={-2000} width={W + 4000} height={H + 4000} fill="url(#schg)" />
          {items.length === 0 && <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={13} fill="#94a3b8">{tr('添加器件后自动生成原理图')}</text>}
          {(() => {
            // 先计算所有连线几何，再统一渲染 + 求 T 型交汇点
            const geoms = (nets || []).map((n) => {
              const fe = entryOf(n.from), te = entryOf(n.to);
              if (!fe || !te) return null;
              const f = P(n.from), t = P(n.to);
              const fSym = fe.sym, tSym = te.sym;
              const fPorts = worldPorts(n.from), tPorts = worldPorts(n.to);
              if (!fPorts.length || !tPorts.length) return null;
              const fCenter = { x: f.x + fSym.w / 2, y: f.y + fSym.h / 2 };
              const tCenter = { x: t.x + tSym.w / 2, y: t.y + tSym.h / 2 };
              const near = (ports: typeof fPorts, peer: { x: number; y: number }) =>
                ports.reduce((b, pp) => (pp.tip.x - peer.x) ** 2 + (pp.tip.y - peer.y) ** 2 < (b.tip.x - peer.x) ** 2 + (b.tip.y - peer.y) ** 2 ? pp : b, ports[0]);
              const fpk = near(fPorts, tCenter), tpk = near(tPorts, fCenter);
              const x1 = fpk.tip.x, y1 = fpk.tip.y;
              const x2 = tpk.tip.x, y2 = tpk.tip.y;
              const midX = Math.round(((x1 + x2) / 2 + (n.midDx ?? 0)) / 10) * 10;
              return { n, x1, y1, x2, y2, midX };
            }).filter((g): g is NonNullable<typeof g> => !!g);

            // T 型交汇点：某线的端点/拐点落在另一根线的线段上（含端点相接≥判定），画实心连接点
            const EPS = 0.6;
            const junctions: { x: number; y: number }[] = [];
            const seen = new Set<string>();
            const onSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
              if (Math.abs(ay - by) < EPS) return Math.abs(py - ay) < EPS && px >= Math.min(ax, bx) - EPS && px <= Math.max(ax, bx) + EPS;
              if (Math.abs(ax - bx) < EPS) return Math.abs(px - ax) < EPS && py >= Math.min(ay, by) - EPS && py <= Math.max(ay, by) + EPS;
              return false;
            };
            for (const a of geoms) {
              const keyPts = [
                { x: a.x1, y: a.y1 }, { x: a.midX, y: a.y1 },
                { x: a.midX, y: a.y2 }, { x: a.x2, y: a.y2 },
              ];
              for (const pt of keyPts) {
                for (const b of geoms) {
                  if (b.n.id === a.n.id) continue;
                  const segs: [number, number, number, number][] = [
                    [b.x1, b.y1, b.midX, b.y1], [b.midX, b.y1, b.midX, b.y2], [b.midX, b.y2, b.x2, b.y2],
                  ];
                  if (segs.some(([ax, ay, bx, by]) => onSeg(pt.x, pt.y, ax, ay, bx, by))) {
                    const k = `${Math.round(pt.x)}_${Math.round(pt.y)}`;
                    if (!seen.has(k)) { seen.add(k); junctions.push(pt); }
                    break;
                  }
                }
              }
            }

            return (<>
            {geoms.map(({ n, x1, y1, x2, y2, midX }) => {
            const isSel = sel === n.id;
            return (
              <g key={n.id}>
                <path d={`M${x1},${y1} H${midX} V${y2} H${x2}`} fill="none" stroke="transparent" strokeWidth={12} style={{ cursor: 'ew-resize' }}
                  onMouseDown={(e) => { e.stopPropagation(); setSel(n.id); setSelSym(null); netDragRef.current = { active: true, id: n.id, sx: e.clientX, dx: n.midDx ?? 0 }; }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => { e.stopPropagation(); setEdit({ type: 'netlabel', id: n.id, text: n.label }); }} />
                <path d={`M${x1},${y1} H${midX} V${y2} H${x2}`} fill="none" stroke={isSel ? '#2563eb' : n.color} strokeWidth={isSel ? 2.2 : 1.4} style={{ pointerEvents: 'none' }} />
                <circle cx={x1} cy={y1} r={2.5} fill={isSel ? '#2563eb' : n.color} /><circle cx={x2} cy={y2} r={2.5} fill={isSel ? '#2563eb' : n.color} />
                {edit?.type === 'netlabel' && edit.id === n.id ? (
                  <foreignObject x={midX - 45} y={Math.min(y1, y2) - 18} width={90} height={22}>
                    <input autoFocus value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} onBlur={finishEdit} onKeyDown={(e) => { if (e.key === 'Enter') finishEdit(); e.stopPropagation(); }} style={{ width: '100%', fontSize: 9, textAlign: 'center', border: '1px solid #93c5fd', borderRadius: 3, outline: 'none' }} />
                  </foreignObject>
                ) : n.label ? (
                  <text x={midX} y={Math.min(y1, y2) - 4} textAnchor="middle" fontSize={8} fontWeight={700} fill={isSel ? '#2563eb' : n.color} fontFamily="monospace" style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setSel(n.id); }} onDoubleClick={(e) => { e.stopPropagation(); setEdit({ type: 'netlabel', id: n.id, text: n.label }); }}>{n.label}</text>
                ) : null}
              </g>
            );
            })}
            {/* 电气交汇点（T 型相连处） */}
            {junctions.map((j, i) => <circle key={'jct' + i} cx={j.x} cy={j.y} r={3} fill="#334155" style={{ pointerEvents: 'none' }} />)}
            </>);
          })()}
          {unitEntries.map(({ key, c, sym, suffix }) => {
            const p = P(key);
            const isSelS = selSym === key;
            return (
              <g key={key} transform={`translate(${p.x},${p.y}) rotate(${p.rotation} ${sym.w / 2} ${sym.h / 2})`}
                onMouseDown={(e) => onSymDown(e, key)} onClick={(e) => e.stopPropagation()}
                style={{ cursor: linking ? 'pointer' : 'grab' }}>
                <rect x={-12} y={-12} width={sym.w + 24} height={sym.h + 24} fill="transparent" stroke={isSelS ? '#2563eb' : 'none'} strokeWidth={1.2} strokeDasharray="4 3" rx={4} />
                {sym.render(refOf(c) + suffix, suffix && suffix !== 'A' ? '' : valOf(c))}
                {/* 双击热点：位号 / 值 */}
                <rect x={sym.w / 2 - 30} y={-16} width={60} height={14} fill="transparent" style={{ cursor: 'text' }}
                  onDoubleClick={(e) => { e.stopPropagation(); setEdit({ type: 'refdes', id: key, text: refOf(c) + suffix }); }} />
                <rect x={sym.w / 2 - 45} y={sym.h / 2 - 6} width={90} height={14} fill="transparent" style={{ cursor: 'text' }}
                  onDoubleClick={(e) => { e.stopPropagation(); setEdit({ type: 'value', id: key, text: valOf(c) }); }} />
                {edit && (edit.type === 'refdes' || edit.type === 'value') && edit.id === key && (
                  <foreignObject x={sym.w / 2 - 50} y={edit.type === 'refdes' ? -20 : sym.h / 2 - 9} width={100} height={22}>
                    <input autoFocus value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} onBlur={finishEdit} onKeyDown={(e) => { if (e.key === 'Enter') finishEdit(); e.stopPropagation(); }} style={{ width: '100%', fontSize: 9, textAlign: 'center', border: '1px solid #93c5fd', borderRadius: 3, outline: 'none' }} />
                  </foreignObject>
                )}
              </g>
            );
          })}
          {/* GND 总线 + 接地引线 */}
          {items.length > 0 && (() => {
            const railY = Math.round((H - 40) / 10) * 10;
            return (
              <g>
                <line x1={20} y1={railY} x2={W - 20} y2={railY} stroke="#334155" strokeWidth={2.5} />
                <text x={26} y={railY - 6} fontSize={9} fontWeight={700} fill="#334155" fontFamily="monospace">GND</text>
                {unitEntries.filter((e) => e.c.category !== 'passive').map(({ key, sym }) => {
                  const p = P(key);
                  const rot90 = ((p.rotation % 180) + 180) % 180 === 90;
                  const gx = p.x + sym.w / 2;
                  const bottomY = p.y + sym.h / 2 + (rot90 ? sym.w / 2 : sym.h / 2);
                  return (
                    <g key={'gnd-' + key}>
                      <line x1={gx} y1={bottomY} x2={gx} y2={railY} stroke="#64748b" strokeWidth={1.2} strokeDasharray="3 2" />
                      <circle cx={gx} cy={railY} r={2.5} fill="#334155" />
                    </g>
                  );
                })}
              </g>
            );
          })()}
          </g>
        </svg>
        <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', gap: 4, alignItems: 'center', background: 'rgba(255,255,255,.92)', borderRadius: 6, padding: '3px 5px', border: '1px solid #e2e8f0', fontSize: 10 }}>
          <button onClick={() => setZoom(Math.max(0.3, zoom * 0.8))} style={zb}>−</button>
          <span onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={{ minWidth: 34, textAlign: 'center', fontWeight: 600, cursor: 'pointer' }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(Math.min(3, zoom * 1.25))} style={zb}>+</button>
        </div>
      </div>
      </>)}
    </div>
  );
}

const tb: React.CSSProperties = { padding: '4px 10px', borderRadius: 5, border: '1px solid #E8F3EE', background: '#fff', color: '#475569', fontSize: 11, fontWeight: 600, cursor: 'pointer' };
const zb: React.CSSProperties = { width: 20, height: 20, border: '1px solid #e2e8f0', borderRadius: 3, background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#475569' };

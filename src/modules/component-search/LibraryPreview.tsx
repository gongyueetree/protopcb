/**
 * modules/component-search/LibraryPreview.tsx
 * 器件 PCB 设计库文件预览 —— 原理图符号 / PCB封装 / 3D模型，可预览可下载。
 * 符号与封装为 SVG（可下载）；3D 为参数化 Three.js 模型（截图下载在 3D 视图中进行）。
 */
import { tr } from '../../shared/i18n';
import { symbolOverrideFor, ensureKicadSymbol, kicadSymbolStatus } from '../../design-core/geometry/lib-file-registry';
import { useMemo, useState, useRef, useEffect } from 'react';
import type { PlacedComponent } from '../../design-core/document/types';
import { symbolFor } from '../schematic/symbols';
import { padFootprintFor } from '../../design-core/geometry/footprint-pads';
import { PX_PER_MM } from '../../design-core/geometry';
import { COLORS } from '../../shared/theme';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildKicadMod, buildKicadSym, downloadText } from './kicadExport';
import { footprintFileStatus, symbolFileStatus, useLibFileStore, type LibFileStatus } from '../../design-core/geometry/lib-file-registry';
import { Component3DPreview } from './Component3DPreview';

function downloadSvg(svgMarkup: string, filename: string) {
  const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svgMarkup], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}


/** 交互式预览：滚轮缩放 · 拖拽平移 · 双击复位；内容 SVG 自适应填满 */
function ZoomPanBox({ children, height = 150 }: { children: React.ReactNode; height?: number }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, sx: 0, sy: 0, px: 0, py: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.min(8, Math.max(0.3, z * (e.deltaY > 0 ? 0.88 : 1.14))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onMM = (e: MouseEvent) => {
      if (!drag.current.active) return;
      setPan({ x: drag.current.px + (e.clientX - drag.current.sx), y: drag.current.py + (e.clientY - drag.current.sy) });
    };
    const onMU = () => { drag.current.active = false; };
    window.addEventListener('mousemove', onMM);
    window.addEventListener('mouseup', onMU);
    return () => { window.removeEventListener('mousemove', onMM); window.removeEventListener('mouseup', onMU); };
  }, []);

  return (
    <div ref={ref} style={{ height, overflow: 'hidden', background: '#fafafa', borderRadius: 6, position: 'relative', cursor: 'grab' }}
      onMouseDown={(e) => { drag.current = { active: true, sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }; }}
      onDoubleClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
      title="滚轮缩放 · 拖拽平移 · 双击复位">
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transformOrigin: 'center' }}>
        {children}
      </div>
      <span style={{ position: 'absolute', right: 4, bottom: 2, fontSize: 8.5, color: '#b6bcc6', pointerEvents: 'none' }}>{Math.round(zoom * 100)}%</span>
    </div>
  );
}

function StatusBadge({ st }: { st: LibFileStatus }) {
  const map: Record<LibFileStatus, [string, string, string]> = {
    loaded: [tr('ezPLM 精确数据 ✓'), '#dcfce7', '#166534'],
    loading: [tr('拉取库文件中…（暂用名字解析）'), '#fef9c3', '#854d0e'],
    failed: [tr('文件解析失败 · 用名字解析兜底'), '#fee2e2', '#991b1b'],
    nourl: [tr('接口未提供文件链接 · 名字解析'), '#f1f5f9', '#64748b'],
  };
  const [text, bg, fg] = map[st];
  return <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, background: bg, color: fg, fontWeight: 700 }}>{text}</span>;
}

export function LibraryPreview({ c }: { c: PlacedComponent }) {
  const libVersion = useLibFileStore((s) => s.version); // 文件到位时自动刷新状态与预览
  // 依赖必须含 libVersion（符号注册后重算）与关联字段（换绑后重算）——
  // 此前只依赖 componentId，注册成功后 memo 仍返回注册前的空态渲染（诊断✓预览✗的根因）
  const sym = useMemo(() => symbolFor(c), [c.componentId, c.display?.symbolFromMpn, c.customSymbolSvg, libVersion]);
  const pads = padFootprintFor(c.footprint.name);

  // 符号 SVG（含边距）；fit=true 用于面板内自适应预览，false 用于下载原尺寸
  const makeSymSvg = (fit: boolean) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={sym.w + 60} height={sym.h + 50} viewBox={`-30 -25 ${sym.w + 60} ${sym.h + 50}`}
      style={fit ? { width: '100%', height: '100%' } : undefined} preserveAspectRatio="xMidYMid meet">
      <rect x={-30} y={-25} width={sym.w + 60} height={sym.h + 50} fill="#fffef9" />
      {sym.render(c.reference, c.mpn)}
    </svg>
  );

  // 占位器件且无任何符号来源 → 空态（不展示误导性默认符号）
  ensureKicadSymbol(c.display?.symbolFromMpn);
  const symUnlinked = c.display?.family === 'Footprint' && !c.customSymbolSvg && !symbolOverrideFor(c.display?.symbolFromMpn ?? c.mpn);

  // 封装 SVG
  const makeFpSvg = (fit: boolean) => pads ? (() => {
    const halfW = Math.max(...pads.pads.map((p) => Math.abs(p.x) + p.w / 2), Math.abs(pads.bodyCx ?? 0) + pads.bodyW / 2) * PX_PER_MM + 10;
    const halfH = Math.max(...pads.pads.map((p) => Math.abs(p.y) + p.h / 2), Math.abs(pads.bodyCy ?? 0) + pads.bodyH / 2) * PX_PER_MM + 10;
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width={halfW * 2} height={halfH * 2} viewBox={`${-halfW} ${-halfH} ${halfW * 2} ${halfH * 2}`}
        style={fit ? { width: '100%', height: '100%' } : undefined} preserveAspectRatio="xMidYMid meet">
        <rect x={-halfW} y={-halfH} width={halfW * 2} height={halfH * 2} fill="#f0f9f4" />
        <rect x={((pads.bodyCx ?? 0) - pads.bodyW / 2) * PX_PER_MM} y={((pads.bodyCy ?? 0) - pads.bodyH / 2) * PX_PER_MM} width={pads.bodyW * PX_PER_MM} height={pads.bodyH * PX_PER_MM} rx={2} fill="none" stroke="#1a6b3c" strokeWidth={1} />
        {pads.pads.map((p, i) => (
          <rect key={i} x={(p.x - p.w / 2) * PX_PER_MM} y={(p.y - p.h / 2) * PX_PER_MM} width={p.w * PX_PER_MM} height={p.h * PX_PER_MM} rx={p.round ? p.w * PX_PER_MM / 2 : 0.8} fill="#c08a2d" stroke="#8a6420" strokeWidth={0.3} />
        ))}
        {pads.pin1 && <circle cx={pads.pin1.x * PX_PER_MM} cy={pads.pin1.y * PX_PER_MM} r={1.8} fill="#dc2626" />}
      </svg>
    );
  })() : null;

  const symSvg = makeSymSvg(true);
  const fpSvg = makeFpSvg(true);

  const dl = (node: React.ReactElement | null, name: string) => {
    if (!node) return;
    downloadSvg(renderToStaticMarkup(node), name);
  };

  return (
    <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.green, marginBottom: 8 }}>📚 PCB 设计库文件</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={cell}>
          <div style={{ ...cellTitle, display: 'flex', alignItems: 'center', gap: 6 }}>{tr('原理图符号')} {!symUnlinked && <StatusBadge st={symbolFileStatus(c.display?.symbolFromMpn ?? c.mpn, c.display?.symbolFileUrl)} />}</div>
          {symUnlinked ? (
            <div style={{ padding: '18px 12px', textAlign: 'center', borderRadius: 8, background: '#f8fafc', border: '1px dashed #cbd5e1' }}>
              <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700 }}>{tr('尚未关联原理图符号')}</div>
              <div style={{ fontSize: 9.5, color: '#94a3b8', marginTop: 4 }}>{tr('用上方「从 ezPLM 库关联」/「KiCad 符号库」/「创建」赋予真实符号')}</div>
              {kicadSymbolStatus(c.display?.symbolFromMpn) && (
                <div style={{ fontSize: 9.5, color: '#b45309', marginTop: 6, wordBreak: 'break-all' }}>{kicadSymbolStatus(c.display?.symbolFromMpn)}</div>
              )}
            </div>
          ) : (
            <>
              <ZoomPanBox>{symSvg}</ZoomPanBox>
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => downloadText(buildKicadSym(c), `${c.mpn}.kicad_sym`)} style={{ ...dlBtn, flex: 1 }}>⬇ .kicad_sym</button>
                <button onClick={() => dl(makeSymSvg(false), `${c.mpn}-symbol.svg`)} style={{ ...dlBtn, flex: 1 }}>⬇ SVG</button>
              </div>
            </>
          )}
        </div>
        <div style={cell}>
          <div style={{ ...cellTitle, display: 'flex', alignItems: 'center', gap: 6 }}>{tr('PCB 封装')} <StatusBadge st={footprintFileStatus(c.footprint.name, c.display?.footprintFileUrl)} /></div>
          <ZoomPanBox>{fpSvg ?? <span style={{ fontSize: 10, color: '#94a3b8' }}>无焊盘数据</span>}</ZoomPanBox>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => { const m = buildKicadMod(c); if (m) downloadText(m, `${c.footprint.name}.kicad_mod`); }} disabled={!fpSvg} style={{ ...dlBtn, flex: 1, opacity: fpSvg ? 1 : 0.5 }}>⬇ .kicad_mod</button>
            <button onClick={() => dl(makeFpSvg(false), `${c.footprint.name}-footprint.svg`)} disabled={!fpSvg} style={{ ...dlBtn, flex: 1, opacity: fpSvg ? 1 : 0.5 }}>⬇ SVG</button>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 8, padding: '8px', borderRadius: 8, background: '#fff', border: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', marginBottom: 6 }}>{tr('3D 模型')}</div>
          <Component3DPreview c={c} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
            <span style={{ flex: 1, fontSize: 9.5, color: '#94a3b8' }}>{c.display?.stepUrl ? tr('STEP 源文件') : tr('ezPLM 未提供该器件的 STEP 文件')}</span>
            {c.display?.stepUrl
              ? <button onClick={() => downloadStep(c.display!.stepUrl!, c.mpn)} style={{ ...dlBtn, padding: '4px 10px' }}>⬇ .step</button>
              : <button disabled style={{ ...dlBtn, opacity: 0.45, cursor: 'not-allowed', padding: '4px 10px' }}>⬇ .step</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

const cell: React.CSSProperties = { background: '#fff', borderRadius: 8, border: '1px solid #f1f5f9', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 };
const cellTitle: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: '#475569' };
const preview: React.CSSProperties = { minHeight: 70, maxHeight: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#fafafa', borderRadius: 6, padding: 4 };
const dlBtn: React.CSSProperties = { fontSize: 10, padding: '4px 0', borderRadius: 5, border: '1px solid #c6e2d0', background: '#f0f9f4', color: '#1f5c3b', fontWeight: 700, cursor: 'pointer' };

/** 受控 STEP 下载：fetch→blob，失败（签名过期/401）提示重新搜索器件刷新，不中断当前页面 */
async function downloadStep(stepUrl: string, mpn: string) {
  try {
    const url = stepUrl.startsWith('/') ? stepUrl : `/api/ezplm?path=file&url=${encodeURIComponent(stepUrl)}`;
    const r = await fetch(url);
    if (!r.ok) {
      let detail = '';
      try { detail = String((await r.json())?.error ?? ''); } catch { /* 非 JSON */ }
      alert(`STEP 下载失败 HTTP ${r.status}${detail ? ' · ' + detail : ''}\n签名链接可能已过期——重新搜索该器件后再试。`);
      return;
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${mpn}.step`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert('STEP 下载失败：' + (e as Error).message);
  }
}

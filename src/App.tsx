/**
 * App.tsx
 * 应用壳 —— 组装搜索面板 / 画布 / 右侧顾问 / 底部 BOM。
 * 所有数据流经 designStore 与 Provider，不再有硬编码逻辑。
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useDesignStore } from './state/designStore';
import { getProviders } from './providers/factory';
import { appConfig } from './config';
import { ComponentSearchPanel } from './modules/component-search/ComponentSearchPanel';
import { FootprintLibraryPanel } from './modules/component-search/FootprintLibraryPanel';
import { LibraryPreview } from './modules/component-search/LibraryPreview';
import { padFootprintFor as padFootprintForT } from './design-core/geometry/footprint-pads';
import { downloadKicadPcb } from './modules/board-editor/pcbExport';
import { getEzplmReferenceDesigns, isEzplmPart, type ReferenceDesign } from './providers/ezplm-live';
import { ensureFootprintFile, ensureSymbolFile, useLibFileStore } from './design-core/geometry/lib-file-registry';
import { fetchDigikeyOffer, formatDkPrice, type DigikeyOffer } from './providers/digikey';
import { geminiComplete, geminiAvailable, extractJson } from './providers/gemini';
import { fetchSupplierOffers, fmtOfferPrice, type SupplierOffer } from './providers/suppliers';
import { searchEzplmParts } from './providers/ezplm-live';
import { ensureStepBytes } from './modules/board-editor/step-loader';
import { CustomPartWizard } from './modules/component-search/CustomPartWizard';
import { loadCustomParts, deleteCustomPart, customPartToResult, bootCustomLib, type CustomPart } from './design-core/custom-lib';
import { parseKicadPcb } from './design-core/geometry/kicad-pcb-import';
import { parseKicadSch } from './design-core/geometry/kicad-sch-import';
import { parseKicadMod } from './design-core/geometry/kicad-file-parser';
import { autoKicadFootprint } from './design-core/geometry/auto-kicad-footprint';
import { useT, useLangStore, useTranslated, tr } from './shared/i18n';
import { registerFootprintOverride, registerSymbolOverride, symbolOverrideFor, footprintOverrideFor } from './design-core/geometry/lib-file-registry';
import { parseKicadSym } from './design-core/geometry/lib-file-registry';
import type { PlacedComponent as PlacedComponentT } from './design-core/document/types';
import { BoardCanvas2D } from './modules/board-editor/BoardCanvas2D';
import { BoardView3D } from './modules/board-editor/BoardView3D';
import { BomPanel } from './modules/bom/BomPanel';
import { AdvisorPanel } from './modules/design-review/AdvisorPanel';
import { BlockDiagramPanel } from './modules/block-diagram/BlockDiagramPanel';
import { SchematicPanel } from './modules/schematic/SchematicPanel';
import { exportDocument, importDocumentFromFile, autosave, exportMarkdownReport } from './modules/report/persistence';
import { COLORS, CATEGORY_DISPLAY, fmtMoney } from './shared/theme';
import type { BoardShapeKind } from './design-core/document/types';

const providers = getProviders();
const ctx = { userId: 'demo-user', organizationId: 'org-demo' };

const SHAPES: { id: BoardShapeKind; icon: string; name: string }[] = [
  { id: 'rect', icon: '▭', name: '矩形' },
  { id: 'rounded', icon: '▢', name: '圆角' },
  { id: 'circle', icon: '○', name: '圆形' },
  { id: 'lshape', icon: '⌐', name: 'L形' },
];

declare const __BUILD_STAMP__: string;

export default function App() {
  useEffect(() => { console.info('%c硬件原型工坊 build ' + __BUILD_STAMP__, 'color:#1f5c3b;font-weight:bold'); }, []);
  const doc = useDesignStore((s) => s.doc);
  const selectedId = useDesignStore((s) => s.selectedId);
  const undo = useDesignStore((s) => s.undo);
  const redo = useDesignStore((s) => s.redo);
  const clearAll = useDesignStore((s) => s.clearAll);
  const rotate = useDesignStore((s) => s.rotateComponent);
  const remove = useDesignStore((s) => s.removeComponent);
  const removeMany = useDesignStore((s) => s.removeComponents);
  const autoArrange = useDesignStore((s) => s.autoArrange);
  const setBoardSize = useDesignStore((s) => s.setBoardSize);
  const setBoardShape = useDesignStore((s) => s.setBoardShape);
  const setBoardCut = useDesignStore((s) => s.setBoardCut);
  const toggleMountingHoles = useDesignStore((s) => s.toggleMountingHoles);
  const activeLayer = useDesignStore((s) => s.activeLayer);
  const setActiveLayer = useDesignStore((s) => s.setActiveLayer);
  const flipLayer = useDesignStore((s) => s.flipComponentLayer);
  const toggleAllRefDes = useDesignStore((s) => s.toggleAllRefDes);
  const hideAllRefDes = useDesignStore((s) => s.hideAllRefDes);
  const toggleRefDesHidden = useDesignStore((s) => s.toggleRefDesHidden);
  // 库文件版本：真实 .kicad_mod/.kicad_sym 解析注册后递增 → 全树切换到精确数据
  useLibFileStore((st) => st.version);
  // 画布器件按需拉取 ezPLM 库文件（幂等）
  useEffect(() => {
    for (const c of doc.components) {
      ensureFootprintFile(c.footprint.name, c.display?.footprintFileUrl);
      ensureSymbolFile(c.display?.symbolFromMpn ?? c.mpn, c.display?.symbolFileUrl); // 仅关联符号时按来源型号注册
      ensureStepBytes(c.display?.stepUrl);
    }
  }, [doc.components]);
  const placeScheme = useDesignStore((s) => s.placeScheme);
  const loadDocument = useDesignStore((s) => s.loadDocument);

  const [rightTab, setRightTab] = useState<'comp' | 'advisor'>('comp');
  const [bottom, setBottom] = useState<'bom' | 'block' | 'schematic' | null>(null);
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [fullscreen, setFullscreen] = useState<'bom' | 'block' | 'schematic' | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [leftTab, setLeftTab] = useState<'model' | 'footprint' | 'custom'>('model');
  const [pcbExportOpen, setPcbExportOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [wizard, setWizard] = useState<{ open: boolean; mpn?: string } | null>(null);
  const [wizardTick, setWizardTick] = useState(0);
  useEffect(() => { bootCustomLib(); }, []);
  // 自动保存（本地）：doc 变更 800ms 防抖写 localStorage；启动时若有存档且当前为空则恢复
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const loadDocumentRef = useRef(false);
  useEffect(() => {
    if (loadDocumentRef.current) return;
    loadDocumentRef.current = true;
    try {
      const saved = localStorage.getItem('cc_doc_autosave');
      if (saved && useDesignStore.getState().doc.components.length === 0) {
        const parsed = JSON.parse(saved) as { doc: Parameters<typeof loadDocument>[0]; at: string };
        if (parsed.doc?.components?.length) { loadDocument(parsed.doc); setSavedAt(parsed.at); }
      }
    } catch { /* 存档损坏则忽略 */ }
  }, [loadDocument]);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const at = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        localStorage.setItem('cc_doc_autosave', JSON.stringify({ doc, at }));
        setSavedAt(at);
      } catch { /* 空间不足等 */ }
    }, 800);
    return () => clearTimeout(t);
  }, [doc]);
  const [linkRow, setLinkRow] = useState<string | null>(null);
  const [linkKw, setLinkKw] = useState('');
  const [linkResults, setLinkResults] = useState<Awaited<ReturnType<typeof searchEzplmParts>>['items']>([]);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkIsRec, setLinkIsRec] = useState(false); // 当前结果是否为自动推荐

  /** 智能推荐：AI 型号逐级截短检索（GD32F103C8T6 → GD32F103C8 → GD32F103 → GD32），
   *  再叠加封装关键词，并集去重取前 6 —— "不能精准匹配"的也给出近似候选 */
  const autoRecommend = async (mpn: string, footprint?: string) => {
    setLinkBusy(true); setLinkIsRec(true);
    const seen = new Set<string>();
    const out: typeof linkResults = [];
    const tryKw = async (kw: string) => {
      if (!kw || kw.length < 3 || out.length >= 6) return;
      const r = await searchEzplmParts(kw, 6).catch(() => ({ available: false, items: [] as typeof linkResults }));
      for (const it of r.items) {
        if (seen.has(it.componentId) || out.length >= 6) continue;
        seen.add(it.componentId); out.push(it);
      }
    };
    const stem = mpn.replace(/[^A-Za-z0-9]/g, '');
    const cuts = [mpn, stem, stem.slice(0, 10), stem.slice(0, 8), stem.slice(0, 6), stem.slice(0, 4)];
    for (const c of [...new Set(cuts)]) { await tryKw(c); if (out.length >= 4) break; }
    if (footprint && out.length < 6) await tryKw(footprint.split('_')[0].split('-')[0]);
    setLinkResults(out);
    setLinkBusy(false);
  };
  const linkSeq = useRef(0);
  /** 关联搜索（防抖 250ms + 序号守卫，避免旧响应覆盖新结果） */
  const searchLink = useCallback((kw: string) => {
    const q = kw.trim();
    const seq = ++linkSeq.current;
    if (!q) { setLinkResults([]); setLinkBusy(false); return; }
    setLinkBusy(true);
    setTimeout(async () => {
      if (seq !== linkSeq.current) return;
      const r = await searchEzplmParts(q, 6).catch(() => ({ items: [] as typeof linkResults }));
      if (seq !== linkSeq.current) return;
      setLinkResults(r.items);
      setLinkBusy(false);
    }, 250);
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useT();
  const lang = useLangStore((st) => st.lang);
  const toggleLang = useLangStore((st) => st.toggle);
  useEffect(() => { document.title = lang === 'en' ? 'Tindie Proto' : '硬件原型工坊'; }, [lang]);

  const selObj = doc.components.find((c) => c.instanceId === selectedId);

  // autosave
  useEffect(() => { autosave(doc); }, [doc]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      if ((e.key === 'r' || e.key === 'R') && selectedId) { e.preventDefault(); rotate(selectedId); }
      if ((e.key === 'l' || e.key === 'L') && selectedId) { e.preventDefault(); flipLayer(selectedId); }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { multiSel } = useDesignStore.getState();
        if (multiSel.length) { e.preventDefault(); removeMany(multiSel); return; }
        if (selectedId) { e.preventDefault(); remove(selectedId); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, undo, redo, rotate, remove, flipLayer]);

  const [aiProposal, setAiProposal] = useState<{ rationale: string; source?: string; fallbackReason?: string; details: (NonNullable<Awaited<ReturnType<typeof providers.components.getComponentDetail>>> & { mapSource?: string })[] } | null>(null);
  const [coreOnly, setCoreOnly] = useState(false);
  useEffect(() => { if (aiProposal) setCoreOnly(false); }, [aiProposal != null]); // eslint-disable-line react-hooks/exhaustive-deps

  const genScheme = async () => {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    try {
      const result = await providers.ai.generateScheme({ prompt: aiPrompt }, ctx);
      // Gemini 真实链路：直接携带完整器件（已完成 ezPLM 云端映射 / 封装占位）
      if (result.items?.length) {
        setAiProposal({ rationale: result.rationale, source: result.source, fallbackReason: result.fallbackReason, details: result.items as unknown as NonNullable<typeof aiProposal>['details'] });
        setAiBusy(false);
        return;
      }
      // Mock 链路：componentIds → 目录映射
      const mapped = await Promise.all(result.componentIds.map(async (id) => {
        const d = await providers.components.getComponentDetail(id, ctx);
        if (d) return { ...d, mapSource: d.org ? ('本组织' as const) : ('ezPLM云端' as const) };
        // 未命中：按 id 猜封装做占位（真实链路中由 LLM 返回封装建议）
        return {
          componentId: `fp_${id}_${Date.now()}`, mpn: id, manufacturer: '—',
          category: 'passive' as const, defaultFootprintName: '0402', family: 'Footprint',
          description: `未映射到 ezPLM 器件，以封装占位`, pins: 2, mapSource: '封装占位' as const,
        };
      }));
      setAiProposal({ rationale: result.rationale, source: result.source, fallbackReason: result.fallbackReason, details: mapped });
    } catch (err) {
      alert('生成失败：' + (err as Error).message);
    }
    setAiBusy(false);
  };

  const confirmScheme = () => {
    if (!aiProposal) return;
    const details = coreOnly ? aiProposal.details.filter((x) => x.category !== 'passive') : aiProposal.details;
    placeScheme(details, { requirement: aiPrompt, rationale: aiProposal.rationale });
    setAiProposal(null);
    // 无源器件/连接器：ezPLM 未收录 → 异步按封装名自动关联 KiCad 官方库（精确焊盘 + 真实 3D）
    setTimeout(() => {
      const comps = useDesignStore.getState().doc.components;
      const seen = new Set<string>();
      for (const c of comps) {
        if (!['passive', 'connector', 'electromech'].includes(c.category)) continue;
        if (c.display?.stepUrl || c.display?.footprintFileUrl) continue;
        const fp = c.footprint.name;
        if (seen.has(fp)) continue;
        seen.add(fp);
        autoKicadFootprint(fp).then((stepUrl) => { if (stepUrl) setStepUrlByFootprint(fp, stepUrl); }).catch(() => { /* 兜底参数化 */ });
      }
    }, 50);
  };

  const importKicad = useDesignStore((s) => s.importKicad);
  const assignSymbolsByReference = useDesignStore((s) => s.assignSymbolsByReference);
  const setSchematicSheet = useDesignStore((s) => s.setSchematicSheet);
  const setStepUrlByFootprint = useDesignStore((s) => s.setStepUrlByFootprint);
  const importPcbText = (text: string): { comps: number; skipped: number } => {
    const data = parseKicadPcb(text);
    // 注册 PCB 内嵌封装定义 → 导入器件焊盘精确、3D 按真实焊盘构建
    for (const [name, def] of Object.entries(data.footprintDefs)) registerFootprintOverride(name, def);
    importKicad(data);
    return { comps: data.comps.length, skipped: data.skipped.length };
  };

  /** 从 .kicad_sch 文本提取内嵌符号并按位号挂到已导入器件（原理图区随即显示真符号） */
  const applySchText = (text: string): { symbols: number; linked: number } => {
    const sch = parseKicadSch(text);
    let symbols = 0;
    const refKeyMap: Record<string, string> = {};
    for (const [libId, block] of Object.entries(sch.libSymbols)) {
      const parsed = parseKicadSym(`(kicad_symbol_lib ${block})`);
      if (!parsed || !parsed.pins.length) continue;
      const key = `KICADSCH:${libId}`;
      registerSymbolOverride(key, parsed);
      try { localStorage.setItem('cc_ksym_' + key, `(kicad_symbol_lib ${block})`); } catch { /* 空间不足忽略 */ }
      symbols++;
      for (const [ref, lid] of Object.entries(sch.refToLibId)) if (lid === libId) refKeyMap[ref] = key;
    }
    const linked = assignSymbolsByReference(refKeyMap);
    // 原理图原样视图数据存入文档（随设计持久化，刷新/导出 JSON 均保留）
    setSchematicSheet({
      instances: sch.instances,
      wires: sch.wires,
      junctions: sch.junctions,
      labels: sch.labels,
      noConnects: sch.noConnects,
      libSymbols: sch.libSymbols,
    });
    return { symbols, linked };
  };

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      if (/\.zip$/i.test(f.name)) {
        // KiCad 工程压缩包：解压 → PCB 上画布 + 原理图符号逐器件挂载
        const { unzipSync, strFromU8 } = await import('fflate');
        const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
        const names = Object.keys(entries).filter((n) => !n.startsWith('__MACOSX') && !n.endsWith('/'));
        const pcbName = names.filter((n) => /\.kicad_pcb$/i.test(n)).sort((a, b) => entries[b].length - entries[a].length)[0];
        const schNames = names.filter((n) => /\.kicad_sch$/i.test(n));
        if (!pcbName) throw new Error(t('压缩包内未找到 .kicad_pcb 文件'));
        const r = importPcbText(strFromU8(entries[pcbName]));
        let symTotal = 0, linkTotal = 0;
        for (const sn of schNames) {
          const rr = applySchText(strFromU8(entries[sn]));
          symTotal += rr.symbols; linkTotal += rr.linked;
        }
        alert(`${t('工程导入完成')}：PCB ${r.comps} ${t('个器件')}${r.skipped ? `（${r.skipped} ${t('个跳过')}）` : ''}${schNames.length ? ` · ${t('原理图')} ${schNames.length} ${t('张')}，${symTotal} ${t('个符号')}，${linkTotal} ${t('个器件已挂真符号')}` : ` · ${t('包内无原理图，符号用名字解析')}`}`);
      } else if (/\.kicad_pcb$/i.test(f.name)) {
        const r = importPcbText(await f.text());
        if (r.skipped) alert(`已导入 ${r.comps} 个器件；${r.skipped} 个封装缺少位置信息被跳过`);
      } else if (/\.kicad_sch$/i.test(f.name)) {
        // 单独补挂原理图（画布已有对应位号的器件时）
        const rr = applySchText(await f.text());
        alert(`${t('原理图符号提取完成')}：${rr.symbols} ${t('个符号')}，${rr.linked} ${t('个器件已挂载')}`);
      } else {
        loadDocument(await importDocumentFromFile(f));
      }
    } catch (err) { alert('导入失败：' + (err as Error).message); }
    e.target.value = '';
  };

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: "-apple-system,'Segoe UI',Roboto,'Noto Sans SC',sans-serif", background: '#F8F9FA', overflow: 'hidden' }}>
      {/* Header */}
      <header style={{ height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', background: '#fff', borderBottom: `2px solid ${COLORS.green}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 24 }}>⚡</span>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: COLORS.green }}>{t('硬件原型工坊')}</span>
            <span style={{ fontSize: 10, color: '#94a3b8' }}>{t('AI 方案生成、器件选型与 PCB 预布局')}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {savedAt && <span title={t('设计已自动保存在本浏览器（localStorage），导出设计可得到可分享的 JSON 文件')}
            style={{ fontSize: 10, color: '#94a3b8', alignSelf: 'center', marginRight: 4 }}>✓ {t('已自动保存')} {savedAt}</span>}
          <button onClick={toggleLang} title={lang === 'zh' ? 'Switch to English' : '切换为中文'}
            style={{ ...hbtn, fontWeight: 800 }}>{lang === 'zh' ? '中 | EN' : 'EN | 中'}</button>
          <button onClick={() => setPcbExportOpen(true)} style={hbtn}>🏭 {t('导出PCB')}</button>
          <button onClick={() => exportMarkdownReport(doc)} style={hbtn}>📄 {t('方案报告')}</button>
          <button onClick={() => exportDocument(doc)} style={hbtn}>⬇ {t('导出设计')}</button>
          <button onClick={() => fileRef.current?.click()} style={hbtn}>⬆ {t('导入设计')}</button>
          <input ref={fileRef} type="file" accept=".json,.kicad_pcb,.kicad_sch,.zip" style={{ display: 'none' }} onChange={onImport} />
        </div>
      </header>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left */}
        <aside style={{ width: 330, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#f4f7f5', borderRight: '1px solid #dbe6dd' }}>
          <div style={{ padding: 12, overflow: 'auto', flex: 1 }}>
            {/* AI scheme */}
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 10, border: '1px solid #c6e2d0', background: '#f7fcf9' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.green, marginBottom: 6 }}>🤖 {t('AI 生成方案')}</div>
              <textarea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} rows={2}
                placeholder={t('如：USB转串口调试器 / WiFi物联网节点 / 12V车载CAN控制器')}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #dbe6dd', fontSize: 13, outline: 'none', resize: 'none', boxSizing: 'border-box', marginBottom: 6 }} />
              <button onClick={genScheme} disabled={aiBusy || !aiPrompt.trim()} title={!aiPrompt.trim() ? t('请先输入需求描述，如：USB转串口调试器') : undefined}
                style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: 'none', background: `linear-gradient(135deg,#245b3a,${COLORS.green})`, color: '#fff', fontSize: 13, fontWeight: 700, cursor: aiBusy ? 'wait' : !aiPrompt.trim() ? 'not-allowed' : 'pointer', opacity: !aiPrompt.trim() && !aiBusy ? 0.55 : 1 }}>
                {aiBusy ? '⟳ ' + t('生成中…') : !aiPrompt.trim() ? t('输入需求后生成方案') : t('生成方案上画布')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
              {([['model', '🔍 ' + t('型号搜索')], ['footprint', '📦 ' + t('KiCad封装库')], ['custom', '🛠 ' + t('定制模块')]] as const).map(([id, label]) => (
                <button key={id} onClick={() => setLeftTab(id)} style={{ flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${leftTab === id ? COLORS.green : '#dbe6dd'}`, borderRadius: 8, background: leftTab === id ? COLORS.greenBg : '#fff', color: leftTab === id ? COLORS.green : '#64748b' }}>{label}</button>
              ))}
            </div>
            {leftTab === 'model' ? <ComponentSearchPanel /> : leftTab === 'footprint' ? <FootprintLibraryPanel /> : <CustomLibPanel onOpenWizard={() => setWizard({ open: true })} wizardTick={wizardTick} />}
          </div>
        </aside>

        {/* Center */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          {/* Toolbar */}
          <div style={{ background: '#fff', borderBottom: '2px solid #E8F3EE', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={undo} style={tbtn}>↩ {t('撤销')}</button>
            <button onClick={redo} style={tbtn}>↪ {t('重做')}</button>
            <button onClick={clearAll} style={tbtn} onClickCapture={(e) => {
              const cnt = useDesignStore.getState().doc.components.length;
              if (cnt > 0 && !window.confirm(t('确定清空画布？将移除') + ` ${cnt} ` + t('个器件（可用「撤销」恢复）'))) e.stopPropagation();
            }}>🧹 {t('清除')}</button>
            <button onClick={autoArrange} title={t('按电气规则重新自动布局全部器件（可撤销）')} style={tbtn}>✨ {t('自动整理')}</button>
            <div style={{ width: 1, height: 18, background: '#E8F3EE', margin: '0 4px' }} />
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #E8F3EE' }}>
              {(['2d', '3d'] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} style={{ padding: '7px 14px', border: 'none', background: view === v ? COLORS.green : '#fff', color: view === v ? '#fff' : '#475569', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{v === '2d' ? t('2D 布局') : t('3D 视图')}</button>
              ))}
            </div>
            {view === '2d' && (
              <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #E8F3EE' }} title="当前放置层（选中器件按 L 换层）">
                {(['TOP', 'BOTTOM'] as const).map((l) => (
                  <button key={l} onClick={() => setActiveLayer(l)} style={{ padding: '7px 12px', border: 'none', background: activeLayer === l ? (l === 'TOP' ? '#c08a2d' : '#3b82c4') : '#fff', color: activeLayer === l ? '#fff' : '#475569', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{l === 'TOP' ? t('Top层') : t('Bottom层')}</button>
                ))}
              </div>
            )}
            <div onClick={toggleAllRefDes} title="显示/隐藏全部位号" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>{t('位号')}</span>
              <div style={{ width: 34, height: 18, borderRadius: 9, background: hideAllRefDes ? '#cbd5e1' : COLORS.green, position: 'relative', transition: 'background .15s' }}>
                <div style={{ position: 'absolute', top: 2, left: hideAllRefDes ? 2 : 18, width: 14, height: 14, borderRadius: 7, background: '#fff', transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.25)' }} />
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{view === '3d' ? t('拖拽旋转 · 滚轮缩放') : t('R 旋转 · L 换层 · Delete 删除 · Shift+拖拽框选 · 拖位号可移动')}</span>
          </div>

          <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex' }}>
            {view === '2d' ? <BoardCanvas2D /> : <BoardView3D />}

            {/* Selected bar — anchored to canvas area bottom */}
            {selObj && !fullscreen && (
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 12, display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 5 }}>
                <div style={{ background: '#fff', borderRadius: 10, padding: '8px 16px', boxShadow: '0 4px 20px rgba(0,0,0,.12)', border: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, pointerEvents: 'auto' }}>
                  <span style={{ fontWeight: 700, color: COLORS.green }}>{selObj.reference}</span>
                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{selObj.mpn}</span>
                  <span style={{ color: '#64748b' }}>{selObj.footprint.name}</span>
                  <button onClick={() => rotate(selObj.instanceId)} style={smbtn}>旋转</button>
                  <button onClick={() => flipLayer(selObj.instanceId)} style={{ ...smbtn, color: selObj.placement.side === 'TOP' ? '#c08a2d' : '#3b82c4' }}>{selObj.placement.side === 'TOP' ? '→Bottom' : '→Top'}</button>
                  <button onClick={() => toggleRefDesHidden(selObj.instanceId)} style={smbtn}>{selObj.refDesDisplay?.hidden ? '显位号' : '隐位号'}</button>
                  <button onClick={() => remove(selObj.instanceId)} style={{ ...smbtn, borderColor: '#fecaca', background: '#fef2f2', color: '#dc2626' }}>移除</button>
                </div>
              </div>
            )}
          </div>

          {/* Bottom bar */}
          <div style={{ display: 'flex', background: '#fff', borderTop: '1px solid #E8F3EE', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', fontSize: 12 }}>
              <span style={{ fontWeight: 600, color: COLORS.green }}>📐 PCB</span>
              <NumInput value={doc.board.widthMm} onChange={(v) => setBoardSize(v, doc.board.heightMm)} label={t('板宽 (mm)')} />
              <span style={{ color: '#cbd5e1' }}>×</span>
              <NumInput value={doc.board.heightMm} onChange={(v) => setBoardSize(doc.board.widthMm, v)} label={t('板高 (mm)')} />
              <div style={{ width: 1, height: 16, background: '#E8F3EE', margin: '0 2px' }} />
              {SHAPES.map((s) => (
                <button key={s.id} title={s.name} onClick={() => setBoardShape(s.id)}
                  style={{ width: 26, height: 22, borderRadius: 4, border: `1.5px solid ${doc.board.shape === s.id ? COLORS.green : '#E8F3EE'}`, background: doc.board.shape === s.id ? COLORS.greenBg : '#fff', color: doc.board.shape === s.id ? COLORS.green : '#94a3b8', fontSize: 12, cursor: 'pointer' }}>{s.icon}</button>
              ))}
              <div style={{ width: 1, height: 16, background: '#E8F3EE', margin: '0 2px' }} />
              <button title="四角定位孔（开启后器件自动避让）" onClick={toggleMountingHoles}
                style={{ padding: '0 8px', height: 22, borderRadius: 4, border: `1.5px solid ${doc.board.mountingHolesEnabled ? COLORS.green : '#E8F3EE'}`, background: doc.board.mountingHolesEnabled ? COLORS.greenBg : '#fff', color: doc.board.mountingHolesEnabled ? COLORS.green : '#94a3b8', fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>⊙ {t('定位孔')}</button>
              {doc.board.shape === 'lshape' && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6, fontSize: 10.5, color: '#64748b' }}>
                  切角
                  <input type="number" value={Math.round(doc.board.cutWidthMm ?? doc.board.widthMm * 0.45)} min={5} max={doc.board.widthMm * 0.9}
                    onChange={(e) => setBoardCut(Number(e.target.value), doc.board.cutHeightMm ?? doc.board.heightMm * 0.4, doc.board.cornerRadiusMm ?? 0)}
                    style={{ width: 42, padding: '2px 4px', borderRadius: 4, border: '1px solid #E8F3EE', fontSize: 11, textAlign: 'center' }} />
                  ×
                  <input type="number" value={Math.round(doc.board.cutHeightMm ?? doc.board.heightMm * 0.4)} min={5} max={doc.board.heightMm * 0.9}
                    onChange={(e) => setBoardCut(doc.board.cutWidthMm ?? doc.board.widthMm * 0.45, Number(e.target.value), doc.board.cornerRadiusMm ?? 0)}
                    style={{ width: 42, padding: '2px 4px', borderRadius: 4, border: '1px solid #E8F3EE', fontSize: 11, textAlign: 'center' }} />
                  mm · 圆角
                  <input type="number" value={doc.board.cornerRadiusMm ?? 0} min={0} max={15}
                    onChange={(e) => setBoardCut(doc.board.cutWidthMm ?? doc.board.widthMm * 0.45, doc.board.cutHeightMm ?? doc.board.heightMm * 0.4, Number(e.target.value))}
                    style={{ width: 36, padding: '2px 4px', borderRadius: 4, border: '1px solid #E8F3EE', fontSize: 11, textAlign: 'center' }} />
                </span>
              )}
            </div>
            <div style={{ flex: 1 }} />
            {([['bom', '🧾 ' + t('BOM清单')], ['block', '📊 ' + t('系统框图')], ['schematic', '⚡ ' + t('原理图')]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setBottom(bottom === id ? null : id)} style={{ padding: '8px 16px', border: 'none', background: bottom === id ? COLORS.greenBg : '#fff', color: bottom === id ? COLORS.green : '#2C3E50', fontSize: 13, fontWeight: 500, cursor: 'pointer', borderTop: bottom === id ? `2px solid ${COLORS.green}` : '2px solid transparent' }}>{label}</button>
            ))}
          </div>
          {bottom && bottom !== fullscreen && (
            <div style={{ height: 340, borderTop: '1px solid #E8F3EE', background: '#fff', overflow: 'hidden', flexShrink: 0 }}>
              {bottom === 'bom' && <BomPanel onToggleFullscreen={() => setFullscreen('bom')} />}
              {bottom === 'block' && <BlockDiagramPanel isFullscreen={false} onToggleFullscreen={() => setFullscreen('block')} />}
              {bottom === 'schematic' && <SchematicPanel isFullscreen={false} onToggleFullscreen={() => setFullscreen('schematic')} />}
            </div>
          )}
        </div>

        {/* Right */}
        <aside style={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#fff', borderLeft: '1px solid #e2e8f0' }}>
          <div style={{ background: COLORS.green, padding: '6px 8px 0', display: 'flex', gap: 4 }}>
            {([['comp', '🔧 ' + t('当前元件')], ['advisor', '🤖 ' + t('AI顾问')]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setRightTab(id)} style={{ flex: 1, padding: '9px 0', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: 'none', borderRadius: '6px 6px 0 0', background: rightTab === id ? '#fff' : 'rgba(255,255,255,.12)', color: rightTab === id ? COLORS.green : 'rgba(255,255,255,.85)' }}>{label}</button>
            ))}
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 12, background: '#f8fafc' }}>
            {rightTab === 'advisor' ? <AdvisorPanel /> : selObj ? <CompDetail iid={selObj.instanceId} onBuild={(mpn) => setWizard({ open: true, mpn })} /> : <div style={{ textAlign: 'center', padding: 40, color: '#7F8C8D', fontSize: 12 }}>{t('点击画布中的元件查看详情')}</div>}
          </div>
        </aside>
      </div>

      {/* PCB 导出对话框 */}
      {pcbExportOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={() => setPcbExportOpen(false)}>
          <div style={{ width: '100%', maxWidth: 560, background: '#fff', borderRadius: 14, padding: 20, boxShadow: '0 24px 80px rgba(0,0,0,.25)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.green, marginBottom: 4 }}>🏭 导出 PCB 布局文件</div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>含板框（Edge.Cuts）、定位孔（非金属化孔）、全部器件真实焊盘与 Top/Bottom 层信息</div>

            <div style={{ padding: 12, borderRadius: 10, border: '1.5px solid #c6e2d0', background: '#f7fcf9', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>KiCad（.kicad_pcb）· 兼容嘉立创EDA专业版</div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>KiCad 7+ 直接打开；嘉立创EDA专业版「文件 → 导入 → KiCad」同一文件即可（两平台使用同一格式，无需分别下载）。注意：当前导出<b>不含电气网络</b>（焊盘无 net），布线需按原理图自行连接</div>
                </div>
                <button onClick={() => { downloadKicadPcb(doc); setPcbExportOpen(false); }} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: COLORS.green, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>⬇ 下载</button>
              </div>
            </div>

            <div style={{ padding: 12, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Altium Designer</div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>.PcbDoc 为专有二进制格式，浏览器端无法直接生成。可行路径：较新版本 AD 的 <b>File → Import Wizard</b> 支持导入 KiCad 工程（若版本不支持，可先用 KiCad 打开再经转换工具迁移）。因此同样下载上方 KiCad 文件即可。</div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setPcbExportOpen(false)} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', fontSize: 13, cursor: 'pointer' }}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* AI 方案确认对话框 */}
      {aiProposal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={() => setAiProposal(null)}>
          <div style={{ width: '100%', maxWidth: 520, background: '#fff', borderRadius: 14, padding: 20, boxShadow: '0 24px 80px rgba(0,0,0,.25)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: COLORS.green }}>🤖 {tr('AI 方案建议 · 请确认')}</span>
              {aiProposal.source === 'gemini'
                ? <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 5, background: '#dcfce7', color: '#166534', fontWeight: 700 }}>{tr('✓ Gemini 生成')}</span>
                : <span title={aiProposal.fallbackReason} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 5, background: '#fef3c7', color: '#92400e', fontWeight: 700 }}>演示引擎{aiProposal.fallbackReason ? ` · ${aiProposal.fallbackReason.slice(0, 46)}` : ''}</span>}
            </div>
            <div style={{ fontSize: 12, color: '#475569', padding: '8px 10px', background: '#f7fcf9', borderRadius: 8, marginBottom: 10 }}><TrSpan text={aiProposal.rationale} /></div>
            <div style={{ maxHeight: 260, overflow: 'auto', marginBottom: 12 }}>
              {aiProposal.details.map((d) => (
                <div key={d.componentId} style={{ padding: '7px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, flex: 1 }}>{d.mpn}</span>
                    {d.mapSource && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, fontWeight: 700, background: d.mapSource === '本组织' ? '#dcfce7' : d.mapSource === 'ezPLM云端' ? '#e0f2fe' : '#fef3c7', color: d.mapSource === '本组织' ? '#166534' : d.mapSource === 'ezPLM云端' ? '#0369a1' : '#92400e' }}>{tr(d.mapSource ?? '')}</span>}
                    <span style={{ color: '#64748b' }}>{d.defaultFootprintName}</span>
                    <span style={{ color: '#059669', fontWeight: 600 }}>{fmtMoney(d.unitPrice?.amount)}</span>
                    {d.mapSource === '封装占位' && (
                      <button onClick={() => {
                        const open = linkRow === d.componentId;
                        setLinkRow(open ? null : d.componentId);
                        if (!open) { setLinkKw(''); setLinkResults([]); autoRecommend(d.mpn, (d as { footprintName?: string; defaultFootprintName?: string }).footprintName ?? (d as { defaultFootprintName?: string }).defaultFootprintName); }
                      }}
                        title="在 ezPLM 库中搜索并关联到真实器件"
                        style={{ border: '1px solid #bae6fd', background: '#f0f9ff', color: '#0369a1', borderRadius: 5, padding: '2px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>🔗 {tr('关联库器件')}</button>
                    )}
                    {d.mapSource === '封装占位' && (
                      <button onClick={() => setWizard({ open: true, mpn: d.mpn })} title="用构建向导创建该器件（AI 提取或手工填写）"
                        style={{ border: '1px solid #ddd6fe', background: '#f5f3ff', color: '#6d28d9', borderRadius: 5, padding: '2px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>🛠 {tr('创建')}</button>
                    )}
                    <button onClick={() => setAiProposal({ ...aiProposal, details: aiProposal.details.filter((x) => x.componentId !== d.componentId) })}
                      style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 14 }}>×</button>
                  </div>
                  <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2 }}><TrSpan text={d.description ?? ''} /></div>
                  {linkRow === d.componentId && (
                    <div style={{ marginTop: 6, padding: 8, borderRadius: 6, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                      <input autoFocus placeholder={tr('搜索 ezPLM 型号…')} value={linkKw}
                        onChange={(e) => { setLinkKw(e.target.value); setLinkIsRec(false); searchLink(e.target.value); }}
                        style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #e2e8f0', fontSize: 11, outline: 'none', boxSizing: 'border-box' }} />
                      {linkBusy && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>{tr('搜索中…')}</div>}
                      {!linkBusy && linkResults.length > 0 && linkIsRec && !linkKw.trim() && (
                        <div style={{ fontSize: 10, color: '#0369a1', marginTop: 4, fontWeight: 700 }}>💡 {tr('按型号词干与封装找到的近似料，点击选用：')}</div>
                      )}
                      {!linkBusy && (linkKw.trim() || linkIsRec) && !linkResults.length && <div style={{ fontSize: 10, color: '#b45309', marginTop: 4 }}>ezPLM 库中无匹配 —— 可点「🛠 创建」自行构建该器件</div>}
                      {linkResults.map((r) => (
                        <div key={r.componentId} onClick={() => {
                          setAiProposal({ ...aiProposal, details: aiProposal.details.map((x) => x.componentId === d.componentId ? ({ ...r, mapSource: 'ezPLM云端' } as unknown as typeof x) : x) });
                          setLinkRow(null); setLinkKw(''); setLinkResults([]);
                        }} style={{ padding: '5px 8px', marginTop: 4, borderRadius: 5, background: '#fff', border: '1px solid #e0f2fe', cursor: 'pointer', fontSize: 11 }}>
                          <b style={{ fontFamily: 'monospace' }}>{r.mpn}</b> <span style={{ color: '#94a3b8' }}>{r.manufacturer} · {r.defaultFootprintName}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
              <label title={t('勾选后确认时跳过电阻/电容/电感等无源器件')}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: `1px solid ${coreOnly ? '#b45309' : '#fde68a'}`, background: coreOnly ? '#fef3c7' : '#fffbeb', color: '#b45309', fontSize: 12, fontWeight: 700, cursor: 'pointer', marginRight: 'auto', userSelect: 'none' }}>
                <input type="checkbox" checked={coreOnly} onChange={(e) => setCoreOnly(e.target.checked)} style={{ accentColor: '#b45309' }} />
                {t('仅加载核心器件')}{coreOnly ? ` ✓ ${t('已开启')}` : ''}
              </label>
              <button onClick={() => setAiProposal(null)} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', fontSize: 13, cursor: 'pointer' }}>{t('取消')}</button>
              <button onClick={confirmScheme} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: COLORS.green, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{tr('确认上画布')} ({(coreOnly ? aiProposal.details.filter((x) => x.category !== 'passive') : aiProposal.details).length})</button>
            </div>
          </div>
        </div>
      )}

      {wizard?.open && (
        <CustomPartWizard initialMpn={wizard.mpn}
          onSaved={() => { setWizard(null); setWizardTick((t) => t + 1); setLeftTab('custom'); }}
          onClose={() => setWizard(null)} />
      )}

      {/* Fullscreen overlays */}
      {fullscreen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.4)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => setFullscreen(null)}>
          <div style={{ width: '100%', maxWidth: 1200, height: '90vh', background: '#fff', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
            {fullscreen === 'bom' && <BomPanel isFullscreen onToggleFullscreen={() => setFullscreen(null)} />}
            {fullscreen === 'block' && <BlockDiagramPanel isFullscreen onToggleFullscreen={() => setFullscreen(null)} />}
            {fullscreen === 'schematic' && <SchematicPanel isFullscreen onToggleFullscreen={() => setFullscreen(null)} />}
          </div>
        </div>
      )}
    </div>
  );
}

function CompDetail({ iid, onBuild }: { iid: string; onBuild?: (mpn: string) => void }) {
  const t = useT();
  const c = useDesignStore((s) => s.doc.components.find((x) => x.instanceId === iid));
  const [alts, setAlts] = useState<{ mpn: string; manufacturer: string; note: string; channel: string; footprint?: string; description?: string }[]>([]);
  const [offers, setOffers] = useState<{ vendor: string; price?: { amount: number; currency: string }; stock?: number; url: string }[]>([]);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof providers.components.getComponentDetail>>>(null);
  const [refDesigns, setRefDesigns] = useState<ReferenceDesign[]>([]);
  const [dkOffer, setDkOffer] = useState<DigikeyOffer | null>(null);
  const [supOffers, setSupOffers] = useState<SupplierOffer[]>([]);
  const [aiAlts, setAiAlts] = useState<{ mpn: string; manufacturer: string; description?: string; footprint: string }[] | null>(null);
  const [aiAltBusy, setAiAltBusy] = useState(false);
  const [aiAltMsg, setAiAltMsg] = useState('');

  const searchAiAlts = async () => {
    if (!c || aiAltBusy) return;
    setAiAltBusy(true);
    setAiAltMsg('');
    setAiAlts(null);
    try {
      if (!(await geminiAvailable())) { setAiAltMsg('未配置 Gemini（Vercel 环境变量 GEMINI_API_KEY）'); setAiAltBusy(false); return; }
      // 1) 大模型给候选替代型号
      const text = await geminiComplete(`器件 ${c.mpn}（${c.manufacturer}，${c.display?.description ?? ''}，封装 ${c.footprint.name}）。
请给出 5 个功能等效或引脚兼容的替代器件型号（不同厂商优先，含国产替代）。严格输出 JSON 数组，勿输出其它文字：
["型号1","型号2","型号3","型号4","型号5"]`);
      const candidates = extractJson<string[]>(text).filter((m) => typeof m === 'string' && m.trim()).slice(0, 6);
      // 2) 逐个经 ezPLM API 验证并取详情（比对映射到我们数据库）
      const found: NonNullable<typeof aiAlts> = [];
      for (const cand of candidates) {
        if (found.length >= 5) break;
        const live = await searchEzplmParts(cand.trim(), 3).catch(() => ({ available: false, items: [] }));
        const hit = live.items.find((i) => i.mpn.toUpperCase().startsWith(cand.trim().toUpperCase()) && i.mpn !== c.mpn) ?? live.items.find((i) => i.mpn !== c.mpn);
        if (hit && !found.some((f) => f.mpn === hit.mpn)) {
          found.push({ mpn: hit.mpn, manufacturer: hit.manufacturer, description: hit.description, footprint: hit.defaultFootprintName });
        }
      }
      setAiAlts(found);
      if (!found.length) setAiAltMsg('大模型候选型号均未在 ezPLM 库中命中');
    } catch (e) {
      setAiAltMsg('搜索失败：' + (e as Error).message);
    }
    setAiAltBusy(false);
  };
  useEffect(() => {
    if (!c) return;
    setRefDesigns([]);
    setDkOffer(null);
    // 自建/占位器件的型号不是真实厂商料号，不查供应商（否则会匹配到无关器件的图片与价格）
    const isSynthetic = c.componentId?.startsWith('custom_') || c.componentId?.startsWith('fp_');
    if (!isSynthetic) fetchDigikeyOffer(c.mpn).then((o) => { if (o?.found) setDkOffer(o); });
    setSupOffers([]);
    if (!isSynthetic) fetchSupplierOffers(c.mpn).then(setSupOffers);
    providers.components.getAlternatives(c.componentId, ctx).then(setAlts);
    providers.components.getSupplierOffers(c.componentId, ctx).then(setOffers);
    providers.components.getComponentDetail(c.componentId, ctx).then(setDetail);
    if (isEzplmPart(c.componentId)) getEzplmReferenceDesigns(c.componentId).then(setRefDesigns);
  }, [c?.componentId]);
  if (!c) return null;
  const disp = CATEGORY_DISPLAY[c.category];
  const coreParams = detail?.coreParams ?? c.display?.attributes ?? {};
  const paramEntries = Object.entries(coreParams).slice(0, 10);
  return (
    <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e2e8f0' }}>
      {/* 头部：位号+型号 与 图片同行 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{c.reference}</div>
          <div style={{ fontSize: 14, fontFamily: 'monospace', color: COLORS.green, fontWeight: 600, wordBreak: 'break-all' }}>{c.mpn}</div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{c.display?.classification ?? disp.name} · {c.manufacturer} · {c.footprint.name}</div>
          {c.display?.classification && <span style={{ display: 'inline-block', marginTop: 4, fontSize: 9.5, padding: '1px 7px', borderRadius: 4, background: '#f1f5f9', color: '#475569', fontWeight: 600 }}>{t('分类：')}<TrSpan text={c.display.classification} /></span>}
        </div>
        <ComponentImage c={c} imageUrl={detail?.imageUrl ?? c.display?.imageUrl ?? dkOffer?.photoUrl} />
      </div>

      {/* 官网 + PDF */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        {(detail?.productUrl ?? c.display?.officialUrl)
          ? <a href={detail?.productUrl ?? c.display?.officialUrl} target="_blank" rel="noreferrer" style={linkBtn}>{tr('🌐 官网')}</a>
          : <a href={`https://www.google.com/search?q=${encodeURIComponent(c.manufacturer + ' ' + c.mpn)}`} target="_blank" rel="noreferrer" style={linkBtn}>{tr('🌐 官网检索')}</a>}
        {(detail?.datasheetUrl ?? c.display?.datasheetUrl)
          ? <a href={detail?.datasheetUrl ?? c.display?.datasheetUrl} target="_blank" rel="noreferrer" style={{ ...linkBtn, borderColor: '#fecaca', background: '#fef2f2', color: '#dc2626' }}>{tr('📄 PDF下载')}</a>
          : <a href={`https://www.google.com/search?q=${encodeURIComponent(c.mpn + ' datasheet pdf')}`} target="_blank" rel="noreferrer" style={{ ...linkBtn, borderColor: '#fecaca', background: '#fef2f2', color: '#dc2626' }}>{tr('📄 PDF检索')}</a>}
      </div>

      {/* 核心参数 */}
      {paramEntries.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.green, marginBottom: 6 }}>⚙️ {t('核心参数')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {paramEntries.map(([k, v]) => (
              <div key={k} style={{ padding: '4px 8px', borderRadius: 6, background: '#f8fafc', border: '1px solid #f1f5f9', fontSize: 10.5 }}>
                <span style={{ color: '#94a3b8' }}>{k}</span> <span style={{ fontWeight: 600, color: '#334155' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {c.display?.description && <div style={{ fontSize: 12, color: '#475569', marginTop: 10 }}><TrSpan text={c.display.description} /></div>}

      {/* 封装占位器件：补型号 + 上传自定义原理图符号 */}
      {(c.display?.family === 'Footprint'
        || (!c.display?.symbolFileUrl && !c.display?.symbolFromMpn && !c.customSymbolSvg)
        || (!c.display?.footprintFileUrl && !footprintOverrideFor(c.footprint.name))) && <FootprintPartEditor c={c} onBuild={onBuild} />}

      <LibraryPreview c={c} />

      {/* 参考设计（ezPLM 实时） */}
      {refDesigns.length > 0 && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6d28d9', marginBottom: 6 }}>{tr('📐 参考设计（来自 ezPLM）')}</div>
          {refDesigns.map((rd, i) => (
            <a key={i} href={rd.link} target="_blank" rel="noreferrer" style={{ display: 'block', padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #ede9fe', textDecoration: 'none' }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: '#4c1d95' }}>{rd.name} <span style={{ fontSize: 9, color: '#94a3b8' }}>↗</span></div>
              {rd.description && <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{rd.description}</div>}
            </a>
          ))}
        </div>
      )}

      {/* 采购渠道：DigiKey 真实 API；Mouser/CECPORT 暂为演示数据（接入 API 后替换） */}
      <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#f0f9ff', border: '1px solid #bae6fd' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#0369a1', marginBottom: 6 }}>🛒 {t('采购渠道')}</div>
        {dkOffer?.found ? (
          <a href={dkOffer.productUrl} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #e0f2fe', textDecoration: 'none' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: '#be123c', width: 66 }}>DigiKey</span>
            <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: '#dcfce7', color: '#166534', fontWeight: 700 }}>{tr('实时')}</span>
            <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>{formatDkPrice(dkOffer)}</span>
            <span style={{ fontSize: 10, color: '#64748b' }}>{tr('库存')} {dkOffer.stock?.toLocaleString() ?? '—'}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: '#94a3b8' }}>{tr('跳转 ↗')}</span>
          </a>
        ) : (
          <div style={{ fontSize: 10, color: '#94a3b8', padding: '4px 8px', marginBottom: 4 }}>DigiKey：{dkOffer === null ? '查询中… / 未配置' : '未收录该型号'}</div>
        )}
        {/* Mouser/Arrow/element14：配置了 Key → 实时数据；未配置 → 演示数据占位 */}
        {['Mouser', 'Arrow', 'element14'].map((vendor) => {
          const real = supOffers.find((o) => o.vendor === vendor);
          if (real?.configured && real.found) {
            return (
              <a key={vendor} href={real.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #e0f2fe', textDecoration: 'none' }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: '#0369a1', width: 66 }}>{vendor}</span>
                <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: '#dcfce7', color: '#166534', fontWeight: 700 }}>{tr('实时')}</span>
                <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>{fmtOfferPrice(real)}</span>
                <span style={{ fontSize: 10, color: '#64748b' }}>{tr('库存')} {real.stock?.toLocaleString() ?? '—'}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: '#94a3b8' }}>{tr('跳转 ↗')}</span>
              </a>
            );
          }
          if (real?.configured && !real.found) {
            return <div key={vendor} style={{ fontSize: 10, color: '#94a3b8', padding: '4px 8px', marginBottom: 4 }}>{vendor}：未收录该型号</div>;
          }
          const mock = mockOffers(c.mpn, vendor);
          return (
            <a key={vendor} href={mock.url} target="_blank" rel="noreferrer" title={`配置 ${vendor === 'Mouser' ? 'MOUSER_API_KEY' : vendor === 'Arrow' ? 'ARROW_LOGIN + ARROW_API_KEY' : 'ELEMENT14_API_KEY'} 后显示实时数据`}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #e0f2fe', textDecoration: 'none', opacity: 0.8 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: '#0369a1', width: 66 }}>{vendor}</span>
              <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: '#fef3c7', color: '#92400e', fontWeight: 700 }}>{tr('演示')}</span>
              <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>¥{mock.price.toFixed(2)}</span>
              <span style={{ fontSize: 10, color: '#64748b' }}>{tr('库存')} {mock.stock.toLocaleString()}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: '#94a3b8' }}>{tr('跳转 ↗')}</span>
            </a>
          );
        })}
        {(() => { const m = mockOffers(c.mpn, 'CECPORT'); return (
          <a href={m.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #e0f2fe', textDecoration: 'none', opacity: 0.8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: '#0369a1', width: 66 }}>CECPORT</span>
            <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: '#fef3c7', color: '#92400e', fontWeight: 700 }}>{tr('演示')}</span>
            <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>¥{m.price.toFixed(2)}</span>
            <span style={{ fontSize: 10, color: '#64748b' }}>{tr('库存')} {m.stock.toLocaleString()}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: '#94a3b8' }}>{tr('跳转 ↗')}</span>
          </a>
        ); })()}
      </div>

      {/* AI 替代料：Gemini 找候选 → ezPLM API 验证映射 */}
      <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: aiAlts?.length || aiAltMsg ? 6 : 0 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309' }}>{tr('💡 替代料（AI × ezPLM）')}</span>
          <span style={{ flex: 1 }} />
          <button onClick={searchAiAlts} disabled={aiAltBusy} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: aiAltBusy ? '#d6d3d1' : '#b45309', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: aiAltBusy ? 'default' : 'pointer' }}>
            {aiAltBusy ? tr('搜索中…') : '🤖 ' + tr('AI 搜索替代料')}
          </button>
        </div>
        {aiAltMsg && <div style={{ fontSize: 10, color: '#92400e' }}>{aiAltMsg}</div>}
        {aiAlts?.map((a, i) => (
          <div key={i} style={{ padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #fef3c7' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: '#e0f2fe', color: '#0369a1', fontWeight: 700 }}>ezPLM</span>
              <span style={{ fontFamily: 'monospace', fontSize: 11.5, fontWeight: 700 }}>{a.mpn}</span>
              <span style={{ fontSize: 9.5, color: '#94a3b8' }}>{a.manufacturer}</span>
              <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: '#475569', fontWeight: 600 }}>{a.footprint}</span>
            </div>
            {a.description && <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>{a.description}</div>}
          </div>
        ))}
      </div>

      {/* 替代料（本组织映射） */}
      {alts.length > 0 && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', marginBottom: 6 }}>💡 替代料（本组织映射）</div>
          {alts.map((a, i) => (
            <div key={i} style={{ padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #fef3c7' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11.5, fontWeight: 700 }}>{a.mpn}</span>
                <span style={{ fontSize: 9.5, color: '#94a3b8' }}>{a.manufacturer}</span>
                {a.footprint && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: '#475569', fontWeight: 600 }}>{a.footprint}</span>}
              </div>
              {a.description && <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>{a.description}</div>}
              <div style={{ fontSize: 10, color: '#64748b' }}>{a.note}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/** 定制模块库面板：已保存器件列表 + 新建入口 */
function CustomLibPanel({ onOpenWizard, wizardTick }: { onOpenWizard: () => void; wizardTick: number }) {
  const addComponent = useDesignStore((s) => s.addComponent);
  const [, setRefresh] = useState(0);
  const parts = useMemo(() => loadCustomParts(), [wizardTick]);
  return (
    <div>
      <button onClick={onOpenWizard} style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: COLORS.green, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}>
        {tr('＋ 新建定制器件（AI 提取 / 手工向导）')}
      </button>
      {parts.length === 0 && <div style={{ textAlign: 'center', padding: 30, color: '#94a3b8', fontSize: 11.5 }}>{tr('还没有定制器件')}<br />{tr('上传 Datasheet 或手工填写管脚即可构建')}</div>}
      {parts.map((p: CustomPart) => (
        <div key={p.id} style={{ padding: '9px 10px', marginBottom: 6, borderRadius: 8, background: '#fff', border: '1px solid #eef2f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: '#f5f3ff', color: '#6d28d9', fontWeight: 700 }}>{tr('自建')}</span>
            <span style={{ fontFamily: 'monospace', fontSize: 12.5, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.mpn}</span>
            <button onClick={() => addComponent(customPartToResult(p))} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: COLORS.green, color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>＋</button>
            <button onClick={() => { deleteCustomPart(p.id); setRefresh((x) => x + 1); }} style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 13 }}>×</button>
          </div>
          <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2 }}>{p.pins.length} {tr('脚')} · {p.footprintName}{p.description ? ' · ' + p.description : ''}</div>
        </div>
      ))}
    </div>
  );
}

/** 演示报价：按型号+渠道稳定哈希生成（对应渠道接入真实 API 后自动切换实时数据） */
function mockOffers(mpn: string, vendor: string): { price: number; stock: number; url: string } {
  let h = 0;
  for (const ch of mpn + vendor) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const base = 0.5 + (h % 2400) / 100;
  const urls: Record<string, string> = {
    Mouser: `https://www.mouser.cn/c/?q=${encodeURIComponent(mpn)}`,
    Arrow: `https://www.arrow.com/en/products/search?q=${encodeURIComponent(mpn)}`,
    element14: `https://cn.element14.com/search?st=${encodeURIComponent(mpn)}`,
    CECPORT: `https://www.cecport.com/search?k=${encodeURIComponent(mpn)}`,
  };
  return { price: base * (0.92 + (h % 20) / 100), stock: 300 + (h % 42000), url: urls[vendor] ?? '#' };
}

/** 封装占位器件编辑：补充型号 / 上传 SVG 原理图符号 */
function FootprintPartEditor({ c, onBuild }: { c: PlacedComponentT; onBuild?: (mpn: string) => void }) {
  const setMpn = useDesignStore((s) => s.setComponentMpn);
  const setSvg = useDesignStore((s) => s.setCustomSymbol);
  const linkSymbol = useDesignStore((s) => s.linkSymbolFrom);
  const linkSymbolByMpn = useDesignStore((s) => s.linkSymbolByMpn);
  const linkFootprint = useDesignStore((s) => s.linkFootprintFrom);
  const addFull = useDesignStore((s) => s.replaceComponentWith);
  // 关联模式：full=整体替换 / symbol=仅借符号 / footprint=仅借封装
  const [mode, setMode] = useState<'full' | 'symbol' | 'footprint' | null>(null);
  const [kw, setKw] = useState('');
  const [results, setResults] = useState<Awaited<ReturnType<typeof searchEzplmParts>>['items']>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const doSearch = useCallback((q: string) => {
    const n = ++seq.current;
    if (!q.trim()) { setResults([]); setBusy(false); return; }
    setBusy(true);
    setTimeout(async () => {
      if (n !== seq.current) return;
      const r = await searchEzplmParts(q.trim(), 6).catch(() => ({ items: [] as typeof results }));
      if (n !== seq.current) return;
      setResults(r.items); setBusy(false);
    }, 250);
  }, []);
  // ── KiCad 官方库跨库关键词搜索 ──
  const [ksSearchKw, setKsSearchKw] = useState('');
  const [ksHits, setKsHits] = useState<{ lib: string; name: string }[]>([]);
  const [ksSearching, setKsSearching] = useState(false);
  const [kfSearchKw, setKfSearchKw] = useState('');
  const [kfHits, setKfHits] = useState<{ lib: string; name: string }[]>([]);
  const [kfSearching, setKfSearching] = useState(false);
  const libSearch = async (kind: 'sym' | 'fp', kw: string) => {
    const q = kw.trim();
    const setBusy = kind === 'sym' ? setKsSearching : setKfSearching;
    const setHits = kind === 'sym' ? setKsHits : setKfHits;
    if (q.length < 2) { setHits([]); return; }
    setBusy(true);
    try {
      const j = await fetch(`/api/kicadlib?path=${kind === 'sym' ? 'symsearch' : 'fpsearch'}&q=${encodeURIComponent(q)}`).then((r) => r.json());
      setHits(Array.isArray(j.hits) ? j.hits : []);
    } catch { setHits([]); }
    setBusy(false);
  };

  // ── KiCad 官方封装库选择 ──
  const [kfOpen, setKfOpen] = useState(false);
  const [kfLibs, setKfLibs] = useState<string[]>([]);
  const [kfLib, setKfLib] = useState('');
  const [kfItems, setKfItems] = useState<string[]>([]);
  const [kfKw, setKfKw] = useState('');
  const [kfMsg, setKfMsg] = useState('');
  const linkFootprintByMpn = useDesignStore((s2) => s2.linkFootprintByMpn);
  const kfToggle = async () => {
    setKfOpen(!kfOpen);
    if (!kfOpen && !kfLibs.length) {
      setKfMsg(tr('加载封装库列表…'));
      try {
        const j = await fetch('/api/kicadlib?path=libs').then((r) => r.json());
        if (Array.isArray(j.libs) && j.libs.length) { setKfLibs(j.libs); setKfMsg(''); }
        else setKfMsg(String(j.error ?? '空列表'));
      } catch (e) { setKfMsg(tr('网络错误，无法访问 KiCad 官方库') + '：' + (e as Error).message); }
    }
  };
  const kfPickLib = async (lib: string) => {
    setKfLib(lib); setKfItems([]); setKfKw(''); setKfMsg('');
    if (!lib) return;
    try {
      const j = await fetch(`/api/kicadlib?path=list&lib=${encodeURIComponent(lib)}`).then((r) => r.json());
      setKfItems(j.items ?? []);
    } catch { setKfMsg(tr('封装列表加载失败')); }
  };
  const kfPick = async (name: string) => {
    setKfMsg(tr('加载封装…'));
    try {
      const r = await fetch(`/api/kicadlib?path=mod&lib=${encodeURIComponent(kfLib)}&name=${encodeURIComponent(name)}`);
      if (!r.ok) { let d = ''; try { d = String((await r.json())?.error ?? ''); } catch { /* */ } throw new Error(`HTTP ${r.status}${d ? ' · ' + d : ''}`); }
      const text = await r.text();
      const fp = parseKicadMod(text);
      if (!fp || !fp.pads.length) throw new Error(tr('封装解析失败（无焊盘）'));
      registerFootprintOverride(name, fp);
      const modelRef = text.match(/\(model\s+"([^"]+)"/)?.[1];
      const mm = modelRef?.match(/([^/\\]+)\.3dshapes[/\\]([^/\\]+)\.(step|stp|wrl)$/i);
      const stepUrl = mm ? `/api/kicadlib?path=step&lib=${encodeURIComponent(mm[1])}&name=${encodeURIComponent(mm[2])}` : undefined;
      linkFootprintByMpn(c.mpn, { footprintName: name, stepUrl, pins: fp.pads.length }); // 同型号全部
      setKfMsg('✓ ' + tr('已关联封装') + ' ' + name + tr('（同型号器件已一并更新）'));
    } catch (e) { setKfMsg(tr('关联失败') + '：' + (e as Error).message); }
  };
  const kfFiltered = kfKw.trim() ? kfItems.filter((n) => n.toLowerCase().includes(kfKw.trim().toLowerCase())) : kfItems;

  // ── KiCad 官方符号库选择 ──
  const [ksOpen, setKsOpen] = useState(false);
  const [ksLibs, setKsLibs] = useState<string[]>([]);
  const [ksLib, setKsLib] = useState('');
  const [ksItems, setKsItems] = useState<string[]>([]);
  const [ksKw, setKsKw] = useState('');
  const [ksMsg, setKsMsg] = useState('');
  const ksToggle = async () => {
    setKsOpen(!ksOpen);
    if (!ksOpen && !ksLibs.length) {
      setKsMsg(tr('加载符号库列表…'));
      try {
        const r = await fetch('/api/kicadlib?path=symlibs');
        const j = await r.json();
        if (Array.isArray(j.libs) && j.libs.length) { setKsLibs(j.libs); setKsMsg(''); }
        else setKsMsg((j.error ? `${j.error}` : `HTTP ${r.status}`) + '（' + tr('可稍后重试') + '）');
      } catch (e) { setKsMsg(tr('网络错误，无法访问 KiCad 官方库') + '：' + (e as Error).message); }
    }
  };
  const ksPickLib = async (lib: string) => {
    setKsLib(lib); setKsItems([]); setKsKw(''); setKsMsg('');
    if (!lib) return;
    try { const j = await fetch(`/api/kicadlib?path=symlist&lib=${encodeURIComponent(lib)}`).then((r) => r.json()); setKsItems(j.items ?? []); }
    catch { setKsMsg(tr('网络错误，无法访问 KiCad 官方库')); }
  };
  const ksPick = async (name: string) => {
    setKsMsg(tr('加载符号…'));
    try {
      const r = await fetch(`/api/kicadlib?path=sym&lib=${encodeURIComponent(ksLib)}&name=${encodeURIComponent(name)}`);
      if (!r.ok) {
        let d = '';
        try { d = String((await r.json())?.error ?? ''); } catch { /* 非 JSON */ }
        throw new Error(`HTTP ${r.status}${d ? ' · ' + d : ''}`);
      }
      const text = await r.text();
      const parsed = parseKicadSym(text);
      if (!parsed || !parsed.pins.length) {
        throw new Error(tr('符号解析失败') + `（${parsed ? tr('解析成功但 0 管脚') : tr('格式无法解析')}；${tr('开头')}：${text.slice(0, 50).replace(/\s+/g, ' ')}）`);
      }
      const key = `KICADSYM:${ksLib}:${name}`;
      registerSymbolOverride(key, parsed);
      try { localStorage.setItem('cc_ksym_' + key, text); } catch { /* 空间不足忽略 */ }
      linkSymbolByMpn(c.mpn, key); // 同型号全部器件一并关联
      setKsMsg(`✓ ${tr('已关联符号')} ${name}`);
      setKsOpen(false);
    } catch (e) { setKsMsg(tr('添加失败：') + (e as Error).message); }
  };
  const ksFiltered = ksKw.trim() ? ksItems.filter((n) => n.toLowerCase().includes(ksKw.trim().toLowerCase())) : ksItems;

  // 一键诊断：把 拉取→解析→注册→渲染 每一步实况打出来
  const [ksDiag, setKsDiag] = useState('');
  const runKsDiag = async () => {
    const key = c.display?.symbolFromMpn ?? '';
    const L: string[] = [`key=${key || '（未关联）'}`, `family=${c.display?.family}`];
    try {
      if (key.startsWith('KICADSYM:')) {
        const parts = key.split(':');
        const r = await fetch(`/api/kicadlib?path=sym&lib=${encodeURIComponent(parts[1])}&name=${encodeURIComponent(parts.slice(2).join(':'))}`);
        const text = await r.text();
        L.push(`拉取 HTTP ${r.status}，头部：${text.slice(0, 60).replace(/\s+/g, ' ')}`);
        if (r.ok) {
          const ps = parseKicadSym(text);
          L.push(ps ? `解析 ✓ pins=${ps.pins.length}` : '解析 ✗ 返回 null');
          if (ps && ps.pins.length) registerSymbolOverride(key, ps);
        }
      }
      L.push(`override 在库=${symbolOverrideFor(key) ? '✓' : '✗'}`);
    } catch (e) { L.push('异常：' + (e as Error).message); }
    setKsDiag(L.join(' | '));
  };

  const openMode = (m: 'full' | 'symbol' | 'footprint') => {
    const next = mode === m ? null : m;
    setMode(next);
    if (next) { const q = c.mpn.startsWith('fp_') ? '' : c.mpn; setKw(q); setResults([]); doSearch(q); }
  };
  const applyPick = (r: (typeof results)[number]) => {
    if (mode === 'full') addFull(c.instanceId, r);
    else if (mode === 'symbol') linkSymbol(c.instanceId, { mpn: r.mpn, symbolFileUrl: r.symbolFileUrl });
    else if (mode === 'footprint') linkFootprint(c.instanceId, { footprintName: r.defaultFootprintName, footprintFileUrl: r.footprintFileUrl, stepUrl: r.stepUrl, pins: r.pins });
    setMode(null); setKw(''); setResults([]);
  };
  const [mpnText, setMpnText] = useState(c.mpn.startsWith('fp_') || c.display?.family === 'Footprint' ? '' : c.mpn);
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    if (!text.trim().startsWith('<svg') && !text.includes('<svg')) { alert('请上传 SVG 格式文件'); return; }
    setSvg(c.instanceId, text);
    e.target.value = '';
  };
  return (
    <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#fdf4ff', border: '1px solid #f0abfc' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#a21caf', marginBottom: 6 }}>{tr('📦 封装占位器件 · 补充信息')}</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input value={mpnText} onChange={(e) => setMpnText(e.target.value)} placeholder={tr('输入器件型号，如 GD32F103C8T6')}
          style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid #e9d5ff', fontSize: 11, outline: 'none' }}
          onKeyDown={(e) => { if (e.key === 'Enter' && mpnText.trim()) setMpn(c.instanceId, mpnText); }} />
        <button onClick={() => mpnText.trim() && setMpn(c.instanceId, mpnText)} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#a21caf', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>{tr('设为型号')}</button>
      </div>
      {/* 从 ezPLM 库关联：整体 / 仅符号 / 仅封装 */}
      <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: '#fff', border: '1px solid #f0abfc' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#86198f', marginBottom: 5 }}>{tr('🔗 从 ezPLM 库关联')}</div>
        <div style={{ display: 'flex', gap: 5 }}>
          {([['full', tr('📦 匹配型号'), '型号+符号+封装全部替换'], ['symbol', tr('📐 仅符号'), '只借用该器件的原理图符号，型号与封装不变'], ['footprint', tr('🔲 仅封装'), '只借用该器件的 PCB 封装与 3D，型号与符号不变']] as const).map(([m, label, tip]) => (
            <button key={m} onClick={() => openMode(m)} title={tip}
              style={{ flex: 1, padding: '5px 4px', borderRadius: 5, fontSize: 10, fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${mode === m ? '#a21caf' : '#e9d5ff'}`, background: mode === m ? '#fae8ff' : '#fff', color: mode === m ? '#86198f' : '#a855f7' }}>{label}</button>
          ))}
        </div>
        {mode && (
          <div style={{ marginTop: 6 }}>
            <input autoFocus value={kw} onChange={(e) => { setKw(e.target.value); doSearch(e.target.value); }}
              placeholder={mode === 'symbol' ? '搜索型号，借用其原理图符号…' : mode === 'footprint' ? '搜索型号，借用其封装…' : '搜索 ezPLM 型号…'}
              style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #e9d5ff', fontSize: 11, outline: 'none', boxSizing: 'border-box' }} />
            {busy && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>{tr('搜索中…')}</div>}
            {!busy && kw.trim() && !results.length && <div style={{ fontSize: 10, color: '#b45309', marginTop: 4 }}>{tr('无匹配结果')}</div>}
            {results.map((r) => (
              <div key={r.componentId} onClick={() => applyPick(r)}
                style={{ padding: '5px 8px', marginTop: 4, borderRadius: 5, background: '#fdf4ff', border: '1px solid #f0abfc', cursor: 'pointer', fontSize: 10.5 }}>
                <b style={{ fontFamily: 'monospace' }}>{r.mpn}</b>
                <span style={{ color: '#94a3b8' }}> · {r.manufacturer}</span>
                <div style={{ color: '#a855f7', fontSize: 9.5, marginTop: 1 }}>
                  {mode === 'symbol' ? `借用符号${r.symbolFileUrl ? '（含 KiCad 符号文件）' : '（按引脚数生成）'}` : mode === 'footprint' ? `借用封装 ${r.defaultFootprintName}` : `${r.defaultFootprintName}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* KiCad 官方符号库：为占位器件挑一个真实原理图符号 */}
      <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: '#fff', border: '1px solid #bae6fd' }}>
        <div onClick={ksToggle} style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
          <span>📐 {tr('KiCad 官方符号库')}</span><span>{ksOpen ? '▾' : '▸'}</span>
        </div>
        {ksOpen && (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 5 }}>
              <input value={ksSearchKw} onChange={(e) => setKsSearchKw(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') libSearch('sym', ksSearchKw); }}
                placeholder={tr('跨库搜索符号，如 STM32F103 / LED')}
                style={{ flex: 1, padding: '5px 8px', borderRadius: 5, border: '1px solid #7dd3fc', fontSize: 11, boxSizing: 'border-box', outline: 'none' }} />
              <button onClick={() => libSearch('sym', ksSearchKw)} disabled={ksSearching || ksSearchKw.trim().length < 2}
                style={{ padding: '5px 10px', borderRadius: 5, border: 'none', background: '#0369a1', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: ksSearching ? 'wait' : 'pointer', opacity: ksSearchKw.trim().length < 2 ? 0.5 : 1 }}>
                {ksSearching ? '⟳' : '🔍'}
              </button>
            </div>
            {ksHits.length > 0 && (
              <div style={{ maxHeight: 160, overflow: 'auto', marginBottom: 5, border: '1px solid #e0f2fe', borderRadius: 5, padding: 4 }}>
                <div style={{ fontSize: 9.5, color: '#0369a1', fontWeight: 700, marginBottom: 3 }}>{tr('搜索结果')}（{ksHits.length}）</div>
                {ksHits.map((h) => (
                  <div key={h.lib + '/' + h.name} onClick={() => { setKsLib(h.lib); ksPick(h.name); }}
                    style={{ padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: '#f0f9ff', fontSize: 10.5, fontFamily: 'monospace', cursor: 'pointer' }} title={h.lib + ' / ' + h.name}>
                    <span style={{ color: '#0891b2' }}>{h.lib}</span> / {h.name}
                  </div>
                ))}
              </div>
            )}
            {!ksSearching && ksSearchKw.trim().length >= 2 && !ksHits.length && (
              <div style={{ fontSize: 10, color: '#b45309', marginBottom: 5 }}>{tr('未搜到，可换关键词或按库浏览')}</div>
            )}
            {ksLibs.length > 0 && (
              <select value={ksLib} onChange={(e) => ksPickLib(e.target.value)} style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #e0f2fe', fontSize: 11, marginBottom: 5, boxSizing: 'border-box' }}>
                <option value="">{tr('选择符号库…')}（{ksLibs.length}）</option>
                {ksLibs.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
            {ksLib && <input value={ksKw} onChange={(e) => setKsKw(e.target.value)} placeholder={tr('筛选符号名…')}
              style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #e0f2fe', fontSize: 11, marginBottom: 5, boxSizing: 'border-box', outline: 'none' }} />}
            <div style={{ maxHeight: 150, overflow: 'auto' }}>
              {ksFiltered.slice(0, 100).map((n) => (
                <div key={n} onClick={() => ksPick(n)}
                  style={{ padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: '#f0f9ff', fontSize: 10.5, fontFamily: 'monospace', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n}>{n}</div>
              ))}
            </div>
            {ksMsg && <div style={{ fontSize: 10, color: ksMsg.startsWith('✓') ? '#16a34a' : '#b91c1c', marginTop: 4 }}>{ksMsg}</div>}
            <button onClick={runKsDiag} style={{ marginTop: 6, padding: '3px 10px', borderRadius: 5, border: '1px solid #cbd5e1', background: '#f8fafc', color: '#475569', fontSize: 10, cursor: 'pointer' }}>🔍 {tr('诊断符号链路')}</button>
            {ksDiag && <div style={{ fontSize: 9.5, color: '#334155', marginTop: 4, wordBreak: 'break-all', background: '#f8fafc', padding: 6, borderRadius: 5, fontFamily: 'monospace' }}>{ksDiag}</div>}
          </div>
        )}
      </div>

      <div style={{ marginTop: 8, padding: 8, borderRadius: 8, border: '1px solid #fde68a', background: '#fffbeb' }}>
        <div onClick={kfToggle} style={{ fontSize: 10, fontWeight: 700, color: '#92400e', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
          <span>📦 {tr('KiCad 官方封装库')}</span><span>{kfOpen ? '▾' : '▸'}</span>
        </div>
        {kfOpen && (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 5 }}>
              <input value={kfSearchKw} onChange={(e) => setKfSearchKw(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') libSearch('fp', kfSearchKw); }}
                placeholder={tr('跨库搜索封装，如 0402 / SOIC-8 / USB_C')}
                style={{ flex: 1, padding: '5px 8px', borderRadius: 5, border: '1px solid #fcd34d', fontSize: 11, boxSizing: 'border-box', outline: 'none' }} />
              <button onClick={() => libSearch('fp', kfSearchKw)} disabled={kfSearching || kfSearchKw.trim().length < 2}
                style={{ padding: '5px 10px', borderRadius: 5, border: 'none', background: '#b45309', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: kfSearching ? 'wait' : 'pointer', opacity: kfSearchKw.trim().length < 2 ? 0.5 : 1 }}>
                {kfSearching ? '⟳' : '🔍'}
              </button>
            </div>
            {kfHits.length > 0 && (
              <div style={{ maxHeight: 160, overflow: 'auto', marginBottom: 5, border: '1px solid #fde68a', borderRadius: 5, padding: 4 }}>
                <div style={{ fontSize: 9.5, color: '#92400e', fontWeight: 700, marginBottom: 3 }}>{tr('搜索结果')}（{kfHits.length}）</div>
                {kfHits.map((h) => (
                  <div key={h.lib + '/' + h.name} onClick={() => { setKfLib(h.lib); kfPick(h.name); }}
                    style={{ padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: '#fffdf5', fontSize: 10.5, fontFamily: 'monospace', cursor: 'pointer' }} title={h.lib + ' / ' + h.name}>
                    <span style={{ color: '#b45309' }}>{h.lib}</span> / {h.name}
                  </div>
                ))}
              </div>
            )}
            {!kfSearching && kfSearchKw.trim().length >= 2 && !kfHits.length && (
              <div style={{ fontSize: 10, color: '#b45309', marginBottom: 5 }}>{tr('未搜到，可换关键词或按库浏览')}</div>
            )}
            {kfLibs.length > 0 && (
              <select value={kfLib} onChange={(e) => kfPickLib(e.target.value)} style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #fde68a', fontSize: 11, marginBottom: 5, boxSizing: 'border-box' }}>
                <option value="">{tr('选择封装库…')}（{kfLibs.length}）</option>
                {kfLibs.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
            {kfLib && <input value={kfKw} onChange={(e) => setKfKw(e.target.value)} placeholder={tr('筛选封装名…')}
              style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #fde68a', fontSize: 11, marginBottom: 5, boxSizing: 'border-box', outline: 'none' }} />}
            <div style={{ maxHeight: 150, overflow: 'auto' }}>
              {kfFiltered.slice(0, 100).map((n) => (
                <div key={n} onClick={() => kfPick(n)}
                  style={{ padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: '#fffdf5', border: '1px solid #fef3c7', fontSize: 10.5, fontFamily: 'monospace', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n}>{n}</div>
              ))}
            </div>
            {kfMsg && <div style={{ fontSize: 10, color: kfMsg.startsWith('✓') ? '#16a34a' : '#b91c1c', marginTop: 4 }}>{kfMsg}</div>}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <button onClick={() => onBuild?.(mpnText.trim() || c.mpn)} title="打开构建向导：上传 PDF / 输入 URL 由 AI 提取管脚与封装，或手工填写"
          style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: '#6d28d9', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>{tr('🤖 从 URL / PDF 提取生成')}</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: '#86198f', cursor: 'pointer' }}>
          <span style={{ padding: '5px 10px', borderRadius: 6, border: '1px dashed #d8b4fe', background: '#fff', fontWeight: 700 }}>{tr('⬆ 上传符号 (SVG)')}</span>
          {c.customSymbolSvg && <span style={{ color: '#16a34a', fontWeight: 700 }}>✓ 已上传</span>}
          <input type="file" accept=".svg,image/svg+xml" onChange={onFile} style={{ display: 'none' }} />
        </label>
      </div>
      {(c.display?.symbolFromMpn || (c.display?.footprintFileUrl && c.display?.family === 'Footprint')) && (
        <div style={{ marginTop: 6, fontSize: 9.5, color: '#16a34a', fontWeight: 700 }}>
          {c.display?.symbolFromMpn && <div>✓ 符号已关联自 {c.display.symbolFromMpn}</div>}
        </div>
      )}
    </div>
  );
}

/** 动态文本（ezPLM 中文数据）：英文模式下自动翻译并缓存 */
function TrSpan({ text }: { text: string }) {
  const tr = useTranslated(text);
  return <>{tr}</>;
}

/** 器件图片：ezPLM 提供 imageUrl 时显示实拍图，否则用封装缩略图兜底 */
function ComponentImage({ c, imageUrl }: { c: PlacedComponentT; imageUrl?: string }) {
  if (imageUrl) return <img src={imageUrl} alt={c.mpn} style={{ width: 64, height: 64, objectFit: 'contain', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }} />;
  const pads = padFootprintForT(c.footprint.name);
  if (!pads) return <div style={{ width: 64, height: 64, borderRadius: 8, border: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, background: '#f8fafc' }}>{CATEGORY_DISPLAY[c.category].icon}</div>;
  const hw = Math.max(...pads.pads.map((p) => Math.abs(p.x) + p.w / 2), pads.bodyW / 2) + 1;
  const hh = Math.max(...pads.pads.map((p) => Math.abs(p.y) + p.h / 2), pads.bodyH / 2) + 1;
  return (
    <svg width={64} height={64} viewBox={`${-hw} ${-hh} ${hw * 2} ${hh * 2}`} style={{ borderRadius: 8, border: '1px solid #e2e8f0', background: '#f0f9f4' }}>
      <rect x={-pads.bodyW / 2} y={-pads.bodyH / 2} width={pads.bodyW} height={pads.bodyH} rx={0.5} fill="none" stroke="#1a6b3c" strokeWidth={hw / 40} />
      {pads.pads.map((p, i) => <rect key={i} x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} rx={p.round ? p.w / 2 : 0.15} fill="#c08a2d" />)}
    </svg>
  );
}

function NumInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#f8fafc', borderRadius: 6, padding: '3px 6px', border: '1px solid #E8F3EE' }}>
      <input aria-label={label} title={label} type="number" value={value} min={20} max={500} step={5} onChange={(e) => onChange(Math.max(20, Math.min(500, Number(e.target.value) || 20)))}
        style={{ width: 44, border: 'none', background: 'transparent', fontSize: 12, fontWeight: 600, color: COLORS.green, outline: 'none', textAlign: 'center', fontFamily: 'monospace' }} />
      <span style={{ color: '#94a3b8', fontSize: 10 }}>mm</span>
    </div>
  );
}

const linkBtn: React.CSSProperties = { padding: '5px 12px', borderRadius: 6, border: '1px solid #c6e2d0', background: '#f0f9f4', color: '#1f5c3b', fontSize: 11, fontWeight: 700, textDecoration: 'none' };
const hbtn: React.CSSProperties = { padding: '5px 12px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const tbtn: React.CSSProperties = { padding: '7px 14px', borderRadius: 6, border: '1px solid #E8F3EE', background: '#fff', fontSize: 13, fontWeight: 500, color: '#2C3E50', cursor: 'pointer' };
const smbtn: React.CSSProperties = { padding: '3px 10px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer', color: '#475569' };

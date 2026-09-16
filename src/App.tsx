/**
 * App.tsx
 * 应用壳 —— 组装搜索面板 / 画布 / 右侧顾问 / 底部 BOM。
 * 所有数据流经 designStore 与 Provider，不再有硬编码逻辑。
 */
import { useState, useEffect, useRef } from 'react';
import { useDesignStore } from './state/designStore';






import { ensureFootprintFile, ensureSymbolFile } from './design-core/geometry/lib-file-registry';
import { useLibFileStore } from './state/libFileStore';



import { ensureStepBytes } from './modules/board-editor/step-loader';
import { CustomPartWizard } from './modules/component-search/CustomPartWizard';
import { bootCustomLib, type CustomPart } from './design-core/custom-lib';






import { useProjectPersistence } from './modules/report/useProjectPersistence';








import { useT, useLangStore, tr, syncDocumentLang } from './shared/i18n';









import { BomPanel } from './modules/bom/BomPanel';

import { BlockDiagramPanel } from './modules/block-diagram/BlockDiagramPanel';
import { SchematicPanel } from './modules/schematic/SchematicPanel';
import { SchemeWorkspace } from './modules/scheme/SchemeWorkspace';




import { formatMoney } from './design-core/money';
import { usePcbViewStore } from './state/pcbViewStore';
import { useWorkspaceLayout } from './modules/app/useWorkspaceLayout';
import { useLibraryLinkController } from './modules/app/useLibraryLinkController';
import { useSchemeController } from './modules/app/useSchemeController';
import { TopNavigation } from './modules/app/TopNavigation';
import { LeftWorkspace } from './modules/app/LeftWorkspace';
import { RightInspector } from './modules/app/RightInspector';
import { MainWorkspace, type MainTab } from './modules/app/MainWorkspace';
import { ExportDialog } from './modules/app/ExportDialog';

import { dialogs } from './modules/ui/dialogStore';
import { DialogHost } from './modules/ui/DialogHost';













/** 主视图页签 —— 与渲染稿一致的信息架构：各视图同级平铺，不再用底部抽屉 */

// 身份来自 providers.identity（demo 模式自然是 demo-user，集成模式是真实身份）

declare const __BUILD_STAMP__: string;
declare const __BUILD_SHA__: string;

/** 项目名校验：非空、≤60 字、不含文件名非法字符（它会成为导出文件名） */
function validateProjectName(v: string): string | null {
  if (!v.trim()) return '项目名不能为空';
  if (v.length > 60) return '项目名不超过 60 个字符';
  if (/[\\/:*?"<>|]/.test(v)) return '项目名不能包含 \\ / : * ? " < > |';
  return null;
}

/**
 * E2E 测试钩子：只在 URL 带 ?e2e=1 时挂到 window，用于跨页面一致性场景直接种入已知状态。
 * 生产访问不会带这个参数；即使带了也只是往画布放器件，不涉及任何权限/计费。
 */
function installE2EHooks() {
  if (typeof window === 'undefined' || !location.search.includes('e2e=1')) return;
  (window as unknown as { __protopcb_test__: unknown }).__protopcb_test__ = {
    /** 当前文档的 JSON（导出/往返场景用） */
    getDocJson: () => JSON.stringify(useDesignStore.getState().doc),
    setBoard: (w: number, h: number) => useDesignStore.getState().setBoardSize(w, h),
    hasMountingHoles: () => useDesignStore.getState().doc.board.mountingHoles?.length ?? 0,
    formatMoney,
    visible3D: () => Object.fromEntries(useDesignStore.getState().doc.components.map((c) => [c.reference, usePcbViewStore.getState().is3DVisible(c.instanceId)])),
    hide3D: (i: number) => { const c = useDesignStore.getState().doc.components[i]; if (c) usePcbViewStore.getState().hideComponent3D(c.instanceId); },
    seedMore(n: number) {
      const st = useDesignStore.getState();
      for (let i = 0; i < n; i++) st.addComponent({ componentId: `e2e_more_${Date.now()}_${i}`, mpn: 'E2E-MORE', manufacturer: '-', category: 'ic', defaultFootprintName: 'SOIC-8_3.9x4.9mm_P1.27mm', family: 'IC', description: '', pins: 8, source: 'EZPLM' });
    },
    seedTrust(levels: ('VERIFIED' | 'CANDIDATE' | 'PLACEHOLDER')[]) {
      const st = useDesignStore.getState();
      st.clearAll();
      levels.forEach((lv, i) => {
        st.addComponent({
          componentId: `e2e_${i}`, mpn: `E2E-${lv}-${i}`, manufacturer: '-', category: 'ic',
          defaultFootprintName: 'SOIC-8_3.9x4.9mm_P1.27mm', family: 'IC', description: '', pins: 8,
          source: lv === 'VERIFIED' ? 'EZPLM' : lv === 'CANDIDATE' ? 'KICAD' : 'AI',
        });
      });
    },
  };
}
installE2EHooks();

export default function App() {
  useEffect(() => { console.info('%c硬件原型工坊 build ' + __BUILD_STAMP__, 'color:#1f5c3b;font-weight:bold'); }, []);
  const buildStamp = `${__BUILD_STAMP__} · ${__BUILD_SHA__}`;
  const doc = useDesignStore((s) => s.doc);
  const { sideW, leftOpen, rightOpen, setLeftManual, setRightManual } = useWorkspaceLayout();
  const link = useLibraryLinkController();
  const { linkRow, setLinkRow, linkKw, setLinkKw, linkResults, linkBusy, linkIsRec, setLinkIsRec, linkNoMatch, autoRecommend, searchLink } = link;
  const selectedId = useDesignStore((s) => s.selectedId);


  // PCB 视图状态（纯 UI，不入文档/undo）






  const selectedNet = useDesignStore((s) => s.selectedNet);

  const undo = useDesignStore((s) => s.undo);
  const redo = useDesignStore((s) => s.redo);

  const rotate = useDesignStore((s) => s.rotateComponent);
  const remove = useDesignStore((s) => s.removeComponent);
  const removeMany = useDesignStore((s) => s.removeComponents);







  const flipLayer = useDesignStore((s) => s.flipComponentLayer);



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

  const loadDocument = useDesignStore((s) => s.loadDocument);

  // 主视图页签：方案概览 / 连接关系 / 原理图 / PCB / 3D结构 / BOM / 审查
  const [mainTab, setMainTab] = useState<MainTab>('pcb');
  // 画布视角由页签派生：PCB 页 = 2D，3D结构页 = 3D（原工具栏的 2D/3D 切换已由页签取代）
  const [rightTab, setRightTab] = useState<'comp' | 'net' | 'advisor'>('comp');
  const [fullscreen, setFullscreen] = useState<'bom' | 'block' | 'schematic' | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const scheme = useSchemeController(aiPrompt);
  const { aiProposal, setAiProposal, aiBusy, aiGate, setAiGate, checkCap, genScheme, reviseScheme, confirmScheme } = scheme;
  /** 定制器件需登录：建好的器件属于账户资产，且提取走 AI */
  const guardCustomPart = () => {
    const g = checkCap('part.custom');
    if (!g.allowed) { setAiGate({ reason: g.reason!, cost: g.cost }); return false; }
    return true;
  };
  const [leftTab, setLeftTab] = useState<'model' | 'footprint' | 'custom'>('model');
  const [pcbExportOpen, setPcbExportOpen] = useState(false);
  const [wizard, setWizard] = useState<{ open: boolean; mpn?: string; editPart?: CustomPart } | null>(null);
  const [wizardTick, setWizardTick] = useState(0);
  useEffect(() => { bootCustomLib(); }, []);
  // 自动保存：统一走 ProjectPersistenceService（唯一 autosave；schema 校验 + 版本迁移 + 损坏备份）。
  // 首次会话不再 removeItem 删用户存档 —— 自动存档尽量保住数据，清空由用户显式点"🧹"。
  const { savedAt } = useProjectPersistence(doc, loadDocument);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useT();
  const lang = useLangStore((st) => st.lang);
  const toggleLang = useLangStore((st) => st.toggle);
  useEffect(() => { syncDocumentLang(lang); }, [lang]);
  useEffect(() => { document.title = lang === 'en' ? 'Tindie Proto' : tr('硬件原型工坊'); }, [lang]);

  const selObj = doc.components.find((c) => c.instanceId === selectedId);


  // 画布点中网络 → 右侧自动切到「网络」页签（取消高亮时保留当前页签，
  // 因为「网络」页在未选网络时会显示"与选中器件相连的器件"，仍然有用）
  useEffect(() => { if (selectedNet != null) setRightTab('net'); }, [selectedNet]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // Esc：从任何页签返回 PCB 布局（页签栏万一被遮挡时的兜底退路）
      if (e.key === 'Escape') { setMainTab('pcb'); return; }
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





  const renameDocument = useDesignStore((s) => s.renameDocument);
  /** 导出前确保工程有名字：未命名时弹框询问，命名后显示在导航栏并作为文件名 */
  const ensureProjectName = async (): Promise<boolean> => {
    const cur = useDesignStore.getState().doc.name;
    if (cur && cur !== tr('未命名设计') && cur !== 'Untitled Design') return true;
    // 受控 ProjectNameDialog（Enter 提交 / Esc 取消 / 焦点困住），不再用阻塞的 window.prompt
    const n = await dialogs.prompt(t('请为该工程命名（将作为导出文件名）'), t('我的硬件方案'), { title: t('项目名称'), validate: validateProjectName });
    if (!n) return false;
    renameDocument(n);
    return true;
  };
  const renameProject = async () => {
    const n = await dialogs.prompt(t('项目名称'), tr(useDesignStore.getState().doc.name), { title: t('重命名项目'), validate: validateProjectName });
    if (n) renameDocument(n);
  };

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: "-apple-system,'Segoe UI',Roboto,'Noto Sans SC',sans-serif", background: '#F8F9FA', overflow: 'hidden' }}>
      {/* 统一对话框/toast 宿主：全应用只挂一次 */}
      <DialogHost />
      <TopNavigation buildStamp={buildStamp} doc={doc} savedAt={savedAt} lang={lang} toggleLang={toggleLang} t={t} fileRef={fileRef} ensureProjectName={ensureProjectName} renameProject={renameProject} setPcbExportOpen={setPcbExportOpen} />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left */}
      <LeftWorkspace sideW={sideW} leftOpen={leftOpen} leftTab={leftTab} setLeftTab={setLeftTab} t={t} aiPrompt={aiPrompt} setAiPrompt={setAiPrompt} aiBusy={aiBusy} genScheme={genScheme} aiGate={aiGate} setAiGate={setAiGate} checkCap={checkCap} guardCustomPart={guardCustomPart} setWizard={setWizard} wizardTick={wizardTick} />

        {/* Center */}
      <MainWorkspace mainTab={mainTab} setMainTab={setMainTab} fullscreen={fullscreen} setFullscreen={setFullscreen} leftOpen={leftOpen} rightOpen={rightOpen} setLeftManual={setLeftManual} setRightManual={setRightManual} selObj={selObj} t={t} />
      <RightInspector sideW={sideW} rightOpen={rightOpen} rightTab={rightTab} setRightTab={setRightTab} t={t} selObj={selObj} guardCustomPart={guardCustomPart} setWizard={setWizard} />
      </div>

      <ExportDialog doc={doc} open={pcbExportOpen} setOpen={setPcbExportOpen} t={t} />

      {/* AI 方案确认对话框 */}
      {aiProposal && (
        <SchemeWorkspace
          proposal={aiProposal}
          busy={aiBusy}
          onRevise={(fb) => reviseScheme(fb)}
          onRemove={(cid) => setAiProposal({ ...aiProposal, details: aiProposal.details.filter((x) => x.componentId !== cid) })}
          onLink={(cid, mpn, fp) => { setLinkRow(cid); setLinkKw(mpn); autoRecommend(mpn, fp); }}
          linkPanel={(cid) => (cid && linkRow === cid ? (
            <div style={{ padding: '8px 10px', background: '#f8fafc', borderTop: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input value={linkKw} autoFocus
                  onChange={(e) => { setLinkKw(e.target.value); setLinkIsRec(false); searchLink(e.target.value); }}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={t('搜索 ezPLM 器件库…')}
                  style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 11, outline: 'none' }} />
                <button onClick={() => setLinkRow(null)} style={{ border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer' }}>×</button>
              </div>
              {linkIsRec && <div style={{ fontSize: 9.5, color: '#7c3aed', marginBottom: 4 }}>{t('按型号逐级截短召回，已过相关性门禁；需人工确认')}</div>}
              {linkNoMatch && <div style={{ fontSize: 10, color: '#b45309', marginBottom: 4 }}>{t('没有合格候选（召回结果与该型号相关性过低，已全部过滤）')}</div>}
              {linkBusy && <div style={{ fontSize: 10, color: '#94a3b8' }}>{t('检索中…')}</div>}
              {linkResults.map((r) => (
                <div key={r.componentId} onClick={() => {
                  setAiProposal((prev) => prev ? {
                    ...prev,
                    details: prev.details.map((d) => d.componentId === cid
                      ? { ...d, ...r, mapSource: tr('ezPLM云端'), group: d.group, core: d.core,
                          trust: { level: 'CANDIDATE' as const, evidence: '用户在方案评审中手工关联，未经型号精确匹配核验', source: 'ezplm-candidate' as const, verifiedAt: new Date().toISOString() } }
                      : d),
                  } : prev);
                  setLinkRow(null);
                }}
                  style={{ padding: '5px 8px', marginBottom: 3, borderRadius: 6, background: '#fff', border: '1px solid #e2e8f0', cursor: 'pointer', fontSize: 10.5 }}>
                  <b style={{ fontFamily: 'monospace' }}>{r.mpn}</b> <span style={{ color: '#64748b' }}>{r.manufacturer} · {r.defaultFootprintName}</span>
                </div>
              ))}
            </div>
          ) : null)}
          onConfirm={(items) => confirmScheme(items)}
          onClose={() => setAiProposal(null)}
        />
      )}

      {wizard?.open && (
        <CustomPartWizard initialMpn={wizard.mpn} editPart={wizard.editPart}
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

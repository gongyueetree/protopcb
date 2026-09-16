/**
 * modules/app/MainWorkspace.tsx — 中央工作区：流程条、画布工具栏、2D/3D/原理图/框图/BOM/审查 各主标签（从 App.tsx 拆出）。
 * 画布相关的 store 状态在本组件内订阅；App 只传布局与标签状态。
 */
import { tr } from '../../shared/i18n';
import { BoardCanvas2D } from '../../modules/board-editor/BoardCanvas2D';
import { OverviewPanel } from '../../modules/report/OverviewPanel';
import { EnclosurePanel } from '../../modules/enclosure/EnclosurePanel';
import { ReviewPanel } from '../../modules/design-review/ReviewPanel';
import { BoardView3D } from '../../modules/board-editor/BoardView3D';
import { BomPanel } from '../../modules/bom/BomPanel';
import { BlockDiagramPanel } from '../../modules/block-diagram/BlockDiagramPanel';
import { SchematicPanel } from '../../modules/schematic/SchematicPanel';
import { PipelineBar } from '../../modules/scheme/PipelineBar';
import { PcbViewControls } from '../../modules/board-editor/PcbViewControls';
import { NumInput } from '../../modules/component-search/CompDetail';
import { COLORS, TOOLBAR_CTRL_H } from '../../shared/theme';
import { useDesignStore } from '../../state/designStore';
import { usePcbViewStore } from '../../state/pcbViewStore';
import { ProjectPersistenceService } from '../../design-core/document/persistence-service';
import { dialogs } from '../ui/dialogStore';
import { ibtn, smbtn } from '../../shared/ui-styles';
import type { PlacedComponent, BoardShapeKind } from '../../design-core/document/types';

const SHAPES: { id: BoardShapeKind; icon: string; name: string }[] = [
  { id: 'rect', icon: '▭', name: tr('矩形') },
  { id: 'rounded', icon: '▢', name: tr('圆角') },
  { id: 'circle', icon: '○', name: tr('圆形') },
  { id: 'lshape', icon: '⌐', name: tr('L形') },
];

export type MainTab = 'overview' | 'block' | 'schematic' | 'pcb' | 'enclosure' | 'bom' | 'review';

const MAIN_TABS: { id: MainTab; label: string; icon: string }[] = [
  { id: 'overview', label: '方案概览', icon: '📋' },
  { id: 'block', label: '系统框图', icon: '📊' },
  { id: 'schematic', label: '原理图', icon: '⚡' },
  { id: 'pcb', label: 'PCB 布局', icon: '📐' },
  { id: 'enclosure', label: '3D 结构', icon: '🧰' },
  { id: 'bom', label: 'BOM', icon: '🧾' },
  { id: 'review', label: '设计审查', icon: '✅' },
];


export function MainWorkspace({ mainTab, setMainTab, fullscreen, setFullscreen, leftOpen, rightOpen, setLeftManual, setRightManual, selObj, t }: {
  mainTab: MainTab; setMainTab: (v: MainTab) => void;
  fullscreen: 'bom' | 'block' | 'schematic' | null; setFullscreen: (v: 'bom' | 'block' | 'schematic' | null) => void;
  leftOpen: boolean; rightOpen: boolean; setLeftManual: (v: boolean) => void; setRightManual: (v: boolean) => void;
  selObj: PlacedComponent | undefined; t: (s: string) => string;
}) {
  const doc = useDesignStore((s) => s.doc);
  const placementViolations = useDesignStore((s) => s.placementViolations);
  const dismissPlacementViolations = useDesignStore((s) => s.dismissPlacementViolations);
  const undo = useDesignStore((s) => s.undo);
  const redo = useDesignStore((s) => s.redo);
  const clearAll = useDesignStore((s) => s.clearAll);
  const rotate = useDesignStore((s) => s.rotateComponent);
  const remove = useDesignStore((s) => s.removeComponent);
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
  const pcbMode = usePcbViewStore((s) => s.mode);
  const hidden3d = usePcbViewStore((s) => s.hidden3dIds);
  const solo3d = usePcbViewStore((s) => s.solo3dId);
  const toggle3D = usePcbViewStore((s) => s.toggleComponent3D);
  const solo3D = usePcbViewStore((s) => s.soloComponent3D);
  const clearSolo = usePcbViewStore((s) => s.clearSolo3D);
  const view: '2d' | '3d' = mainTab === 'enclosure' ? '3d' : '2d';
  /**
   * 工具栏按页过滤：PCB 专用控件（自动整理 / 视图模式 / Top-Bottom 层 / 位号 / 快捷键提示）
   * 只在与布局相关的页显示。此前它们在方案概览、框图、原理图、BOM 页也常驻，
   * 既压缩了绘图空间，又诱导在不相干的页面上做无效操作（测评报告第 4 条）。
   */
  const isLayoutPage = mainTab === 'pcb' || mainTab === 'enclosure';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      {/* 流程状态条：每格状态由文档事实推导，不是装饰 */}
      <PipelineBar />
      {/* Toolbar */}
      <div style={{ background: '#fff', borderBottom: '2px solid #E8F3EE', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, rowGap: 6, flexWrap: 'wrap', minHeight: TOOLBAR_CTRL_H + 16 }}>
        <button onClick={() => setLeftManual(!leftOpen)} title={t('折叠/展开左侧器件栏')} style={ibtn}>{leftOpen ? '◧' : '▶'}</button>
        <span style={{ width: 1, height: 22, background: '#E8F3EE', margin: '0 2px' }} />
        <button onClick={undo} style={ibtn} title={t('撤销')} aria-label={t('撤销')}>↩</button>
        <button onClick={redo} style={ibtn} title={t('重做')} aria-label={t('重做')}>↪</button>
        <button onClick={() => { clearAll(); ProjectPersistenceService.clearByUser(); }} style={ibtn} title={t('清除')} aria-label={t('清除')} onClickCapture={(e) => {
          const cnt = useDesignStore.getState().doc.components.length;
          if (cnt > 0) {
            // 非阻塞确认：先拦下本次点击，用户确认后再真正清空
            e.stopPropagation();
            void dialogs.confirm(t('确定清空画布？将移除') + ` ${cnt} ` + t('个器件并删除本地自动存档（可用「撤销」恢复画布）'), t('清空画布'))
              .then((ok) => { if (ok) { clearAll(); ProjectPersistenceService.clearByUser(); } });
          }
        }}>🧹</button>
        {isLayoutPage && <button onClick={autoArrange} style={ibtn} title={t('自动整理') + ' — ' + t('按电气规则重新自动布局全部器件（可撤销）')} aria-label={t('自动整理')}>✨</button>}
        {isLayoutPage && <div style={{ width: 1, height: 18, background: '#E8F3EE', margin: '0 4px' }} />}
        {view === '2d' && mainTab === 'pcb' && <PcbViewControls />}
        {isLayoutPage && view === '2d' && (
          <div style={{ display: 'flex', height: TOOLBAR_CTRL_H, borderRadius: 6, overflow: 'hidden', border: '1px solid #E8F3EE' }} title={tr('当前放置层（选中器件按 L 换层）')}>
            {(['TOP', 'BOTTOM'] as const).map((l) => (
              <button key={l} onClick={() => setActiveLayer(l)} style={{ height: TOOLBAR_CTRL_H, padding: '0 12px', border: 'none', whiteSpace: 'nowrap', lineHeight: `${TOOLBAR_CTRL_H}px`, background: activeLayer === l ? (l === 'TOP' ? '#c08a2d' : '#3b82c4') : '#fff', color: activeLayer === l ? '#fff' : '#475569', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{l === 'TOP' ? t('Top层') : t('Bottom层')}</button>
            ))}
          </div>
        )}
        {isLayoutPage && <div onClick={toggleAllRefDes} title={tr('显示/隐藏全部位号')} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>{t('位号')}</span>
          <div style={{ width: 34, height: 18, borderRadius: 9, background: hideAllRefDes ? '#cbd5e1' : COLORS.green, position: 'relative', transition: 'background .15s' }}>
            <div style={{ position: 'absolute', top: 2, left: hideAllRefDes ? 2 : 18, width: 14, height: 14, borderRadius: 7, background: '#fff', transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.25)' }} />
          </div>
        </div>}
        <div style={{ flex: 1 }} />
        {isLayoutPage && <span style={{ fontSize: 11, color: '#94a3b8' }}>{view === '3d' ? t('拖拽旋转 · 滚轮缩放') : t('R 旋转 · L 换层 · Delete 删除 · Shift+拖拽框选 · 拖位号可移动')}</span>}
        <button onClick={() => setRightManual(!rightOpen)} title={t('折叠/展开右侧面板')} style={ibtn}>{rightOpen ? '◨' : '◀'}</button>
      </div>
    
      <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex' }}>
        {mainTab === 'overview' ? <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}><OverviewPanel /></div>
          : mainTab === 'schematic' ? <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}><SchematicPanel isFullscreen={false} onToggleFullscreen={() => setFullscreen('schematic')} /></div>
          : mainTab === 'bom' ? <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}><BomPanel onToggleFullscreen={() => setFullscreen('bom')} /></div>
          : mainTab === 'review' ? <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}><ReviewPanel /></div>
          : mainTab === 'block' ? <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}><BlockDiagramPanel isFullscreen={false} onToggleFullscreen={() => setFullscreen('block')} /></div>
          : mainTab === 'enclosure' ? (
            <>
              <BoardView3D />
              <div style={{ width: 316, flexShrink: 0, borderLeft: '1px solid #e2e8f0', overflow: 'hidden' }}><EnclosurePanel /></div>
            </>
          )
          : <BoardCanvas2D />}
    
        {/* 自动放置违规提示：solvePlacementDetailed success=false 的器件绝不静默当作成功 */}
        {Object.keys(placementViolations).length > 0 && (
          <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 6, background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 10, padding: '8px 14px', boxShadow: '0 4px 16px rgba(0,0,0,.12)', fontSize: 11.5, color: '#92400e', maxWidth: '80%', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span>⚠ {t('以下器件未找到完全合法的放置位置（以"最不坏"位置放下，请手动调整）：')}
              {Object.entries(placementViolations).slice(0, 6).map(([iid, vs]) => {
                const ref = doc.components.find((c) => c.instanceId === iid)?.reference ?? iid.slice(0, 6);
                return `${ref}（${vs.map((v) => v.detail).join('；')}）`;
              }).join('、')}
              {Object.keys(placementViolations).length > 6 ? ` …${t('等')} ${Object.keys(placementViolations).length} ${t('个')}` : ''}
            </span>
            <button onClick={dismissPlacementViolations} style={{ border: 'none', background: 'transparent', color: '#92400e', fontWeight: 800, cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
          </div>
        )}
    
        {/* Selected bar — anchored to canvas area bottom */}
        {selObj && !fullscreen && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 12, display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 5 }}>
            <div style={{ background: '#fff', borderRadius: 10, padding: '8px 16px', boxShadow: '0 4px 20px rgba(0,0,0,.12)', border: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, pointerEvents: 'auto' }}>
              <span style={{ fontWeight: 700, color: COLORS.green }}>{selObj.reference}</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{selObj.mpn}</span>
              <span style={{ color: '#64748b' }}>{selObj.footprint.name}</span>
              <button onClick={() => rotate(selObj.instanceId)} style={smbtn}>{tr('旋转')}</button>
              <button onClick={() => flipLayer(selObj.instanceId)} style={{ ...smbtn, color: selObj.placement.side === 'TOP' ? '#c08a2d' : '#3b82c4' }}>{selObj.placement.side === 'TOP' ? '→Bottom' : '→Top'}</button>
              <button onClick={() => toggleRefDesHidden(selObj.instanceId)} style={smbtn}>{selObj.refDesDisplay?.hidden ? tr('显位号') : tr('隐位号')}</button>
              {pcbMode !== '2d' && (
                <>
                  <button onClick={() => toggle3D(selObj.instanceId)}
                    title={tr('只隐藏该器件的 3D 模型，焊盘/网络高亮/选中/拖拽全部保留')}
                    style={{ ...smbtn, color: hidden3d[selObj.instanceId] ? '#94a3b8' : COLORS.green }}>
                    {hidden3d[selObj.instanceId] ? t('显示3D') : t('隐藏3D')}
                  </button>
                  <button onClick={() => (solo3d === selObj.instanceId ? clearSolo() : solo3D(selObj.instanceId))}
                    title={tr('只显示该器件的 3D，其余器件仅保留 2D')}
                    style={{ ...smbtn, color: solo3d === selObj.instanceId ? COLORS.green : '#475569' }}>
                    {solo3d === selObj.instanceId ? t('退出单件') : t('仅看此器件')}
                  </button>
                </>
              )}
              <button onClick={() => remove(selObj.instanceId)} style={{ ...smbtn, borderColor: '#fecaca', background: '#fef2f2', color: '#dc2626' }}>{tr('移除')}</button>
            </div>
          </div>
        )}
      </div>
    
      {/* Bottom bar：板参数（仅 PCB / 3D结构 页相关）+ 主视图页签 */}
      <div style={{ display: 'flex', flexDirection: 'column', background: '#fff', borderTop: '1px solid #E8F3EE', flexShrink: 0, position: 'relative', zIndex: 4 }}>
        <div style={{ display: (mainTab === 'pcb' || mainTab === 'enclosure') ? 'flex' : 'none', alignItems: 'center', gap: 8, padding: '6px 16px', fontSize: 12 }}>
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
          <button data-testid="toggle-mounting-holes" title={tr('四角定位孔（开启后器件自动避让）')} onClick={toggleMountingHoles}
            style={{ padding: '0 8px', height: 22, borderRadius: 4, border: `1.5px solid ${doc.board.mountingHolesEnabled ? COLORS.green : '#E8F3EE'}`, background: doc.board.mountingHolesEnabled ? COLORS.greenBg : '#fff', color: doc.board.mountingHolesEnabled ? COLORS.green : '#94a3b8', fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>⊙ {t('定位孔')}</button>
          {doc.board.shape === 'lshape' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6, fontSize: 10.5, color: '#64748b' }}>
              {tr('切角')}
              <input type="number" value={Math.round(doc.board.cutWidthMm ?? doc.board.widthMm * 0.45)} min={5} max={doc.board.widthMm * 0.9}
                onChange={(e) => setBoardCut(Number(e.target.value), doc.board.cutHeightMm ?? doc.board.heightMm * 0.4, doc.board.cornerRadiusMm ?? 0)}
                style={{ width: 42, padding: '2px 4px', borderRadius: 4, border: '1px solid #E8F3EE', fontSize: 11, textAlign: 'center' }} />
              ×
              <input type="number" value={Math.round(doc.board.cutHeightMm ?? doc.board.heightMm * 0.4)} min={5} max={doc.board.heightMm * 0.9}
                onChange={(e) => setBoardCut(doc.board.cutWidthMm ?? doc.board.widthMm * 0.45, Number(e.target.value), doc.board.cornerRadiusMm ?? 0)}
                style={{ width: 42, padding: '2px 4px', borderRadius: 4, border: '1px solid #E8F3EE', fontSize: 11, textAlign: 'center' }} />
              {tr('mm · 圆角')}
              <input type="number" value={doc.board.cornerRadiusMm ?? 0} min={0} max={15}
                onChange={(e) => setBoardCut(doc.board.cutWidthMm ?? doc.board.widthMm * 0.45, doc.board.cutHeightMm ?? doc.board.heightMm * 0.4, Number(e.target.value))}
                style={{ width: 36, padding: '2px 4px', borderRadius: 4, border: '1px solid #E8F3EE', fontSize: 11, textAlign: 'center' }} />
            </span>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-start', width: '100%', overflowX: 'auto', borderTop: (mainTab === 'pcb' || mainTab === 'enclosure') ? '1px solid #f1f5f9' : 'none' }}>
          {MAIN_TABS.map((tb) => (
            <button key={tb.id} onClick={() => setMainTab(mainTab === tb.id && tb.id !== 'pcb' ? 'pcb' : tb.id)} title={mainTab === tb.id && tb.id !== 'pcb' ? t('再次点击返回 PCB 布局') : t(tb.label)}
              style={{ padding: '8px 14px', border: 'none', whiteSpace: 'nowrap', background: mainTab === tb.id ? COLORS.greenBg : '#fff', color: mainTab === tb.id ? COLORS.green : '#2C3E50', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', borderTop: mainTab === tb.id ? `2px solid ${COLORS.green}` : '2px solid transparent' }}>
              {tb.icon} {t(tb.label)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

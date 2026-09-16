/**
 * modules/app/LeftWorkspace.tsx — 左侧工作区：AI 需求输入 / 型号搜索 / KiCad 封装库 / 定制模块（从 App.tsx 拆出）
 */
import { ComponentSearchPanel } from '../../modules/component-search/ComponentSearchPanel';
import { FootprintLibraryPanel } from '../../modules/component-search/FootprintLibraryPanel';
import { CustomLibPanel } from '../../modules/component-search/CompDetail';
import { AiGateNotice } from '../../modules/account/AccountBar';
import { COLORS } from '../../shared/theme';
import type { DenyReason, Capability } from '../../design-core/entitlements';
import type { CustomPart } from '../../design-core/custom-lib';
export function LeftWorkspace({ sideW, leftOpen, leftTab, setLeftTab, t, aiPrompt, setAiPrompt, aiBusy, genScheme, aiGate, setAiGate, checkCap, guardCustomPart, setWizard, wizardTick }: { sideW: { left: number; right: number }, leftOpen: boolean, leftTab: 'model' | 'footprint' | 'custom', setLeftTab: (v: 'model' | 'footprint' | 'custom') => void, t: (s: string) => string, aiPrompt: string, setAiPrompt: (v: string) => void, aiBusy: boolean, genScheme: () => Promise<void>, aiGate: { reason: DenyReason; cost?: number } | null, setAiGate: (v: { reason: DenyReason; cost?: number } | null) => void, checkCap: (c: Capability) => { allowed: boolean }, guardCustomPart: () => boolean, setWizard: (w: { open: boolean; mpn?: string; editPart?: CustomPart } | null) => void, wizardTick: number, }) {
  return (
    <aside style={{ width: sideW.left, flexShrink: 0, display: leftOpen ? 'flex' : 'none', flexDirection: 'column', background: '#f4f7f5', borderRight: '1px solid #dbe6dd' }}>
      <div style={{ padding: 12, overflow: 'auto', flex: 1 }}>
        {/* AI scheme */}
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 10, border: '1px solid #c6e2d0', background: '#f7fcf9' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.green, marginBottom: 6 }}>🤖 {t('AI 生成方案')}</div>
          <textarea value={aiPrompt} rows={2}
            onChange={(e) => {
              setAiPrompt(e.target.value);
              // 随内容自动增高（约 2~10 行），超出后再滚动
              const el = e.target;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
            }}
            placeholder={t('如：USB供电的温湿度采集器，带屏幕显示，低功耗，尺寸不超过 60 × 40 mm')}
            style={{ width: '100%', minHeight: 52, maxHeight: 220, padding: '8px 10px', borderRadius: 8, border: '1px solid #dbe6dd', fontSize: 13, lineHeight: 1.5, outline: 'none', resize: 'none', overflowY: 'auto', boxSizing: 'border-box', marginBottom: 6 }} />
          {aiGate && <div style={{ marginBottom: 6 }}><AiGateNotice reason={aiGate.reason} cost={aiGate.cost} onClose={() => setAiGate(null)} /></div>}
          <button onClick={genScheme} disabled={aiBusy || !aiPrompt.trim()} title={!aiPrompt.trim() ? t('请先输入需求描述，如：USB转串口调试器') : undefined}
            style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: 'none', background: `linear-gradient(135deg,#245b3a,${COLORS.green})`, color: '#fff', fontSize: 13, fontWeight: 700, cursor: aiBusy ? 'wait' : !aiPrompt.trim() ? 'not-allowed' : 'pointer', opacity: !aiPrompt.trim() && !aiBusy ? 0.55 : 1 }}>
            {aiBusy ? '⟳ ' + t('生成中…') : !aiPrompt.trim() ? t('输入需求后生成方案') : t('生成方案上画布')}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
          {([['model', '🔍 ' + t('型号搜索')], ['footprint', '📦 ' + t('KiCad封装库')],
             ['custom', (checkCap('part.custom').allowed ? '🛠 ' : '🔑 ') + t('定制模块')]] as const).map(([id, label]) => (
            <button key={id} onClick={() => { if (id === 'custom' && !guardCustomPart()) return; setLeftTab(id); }} style={{ flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${leftTab === id ? COLORS.green : '#dbe6dd'}`, borderRadius: 8, background: leftTab === id ? COLORS.greenBg : '#fff', color: leftTab === id ? COLORS.green : '#64748b' }}>{label}</button>
          ))}
        </div>
        {aiGate && <div style={{ padding: '0 10px 8px' }}><AiGateNotice reason={aiGate.reason} cost={aiGate.cost} onClose={() => setAiGate(null)} /></div>}
        {leftTab === 'model' ? <ComponentSearchPanel /> : leftTab === 'footprint' ? <FootprintLibraryPanel /> : <CustomLibPanel
            onOpenWizard={() => { if (guardCustomPart()) setWizard({ open: true }); }}
            onEditPart={(p) => { if (guardCustomPart()) setWizard({ open: true, editPart: p }); }}
            wizardTick={wizardTick} />}
      </div>
    </aside>
  );
}

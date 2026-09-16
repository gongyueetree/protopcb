/**
 * modules/app/RightInspector.tsx — 右侧检视器：当前元件 / 连接 / AI 顾问（从 App.tsx 拆出）
 */
import { NetInspector } from '../../modules/connectivity/NetInspector';
import { AdvisorPanel } from '../../modules/design-review/AdvisorPanel';
import { CompDetail } from '../../modules/component-search/CompDetail';
import { COLORS } from '../../shared/theme';
import type { PlacedComponent } from '../../design-core/document/types';
import type { CustomPart } from '../../design-core/custom-lib';
export function RightInspector({ sideW, rightOpen, rightTab, setRightTab, t, selObj, guardCustomPart, setWizard }: { sideW: { left: number; right: number }, rightOpen: boolean, rightTab: 'comp' | 'net' | 'advisor', setRightTab: (v: 'comp' | 'net' | 'advisor') => void, t: (s: string) => string, selObj: PlacedComponent | undefined, guardCustomPart: () => boolean, setWizard: (w: { open: boolean; mpn?: string; editPart?: CustomPart } | null) => void }) {
  return (
    <aside style={{ width: sideW.right, flexShrink: 0, display: rightOpen ? 'flex' : 'none', flexDirection: 'column', background: '#fff', borderLeft: '1px solid #e2e8f0' }}>
      <div style={{ background: COLORS.green, padding: '6px 8px 0', display: 'flex', gap: 4 }}>
        {([['comp', '🔧 ' + t('当前元件')], ['net', '🔗 ' + t('连接')], ['advisor', '🤖 ' + t('AI顾问')]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setRightTab(id)} style={{ flex: 1, padding: '9px 0', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: 'none', borderRadius: '6px 6px 0 0', background: rightTab === id ? '#fff' : 'rgba(255,255,255,.12)', color: rightTab === id ? COLORS.green : 'rgba(255,255,255,.85)' }}>{label}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12, background: '#f8fafc' }}>
        {rightTab === 'advisor' ? <AdvisorPanel />
          : rightTab === 'net' ? <NetInspector />
          // key = 实例 id：切换器件时整块重挂载。
          // 详情面板里有十几处局部 state（补充信息输入框、KiCad 符号/封装检索关键词、
          // 检索结果、诊断信息…），不重挂载就会留在上一个器件的值上 —— 顶部已经换了型号，
          // 下面几个框还显示着上一颗料的内容。
          : selObj ? <CompDetail key={selObj.instanceId} iid={selObj.instanceId} onBuild={(mpn) => { if (guardCustomPart()) setWizard({ open: true, mpn }); }} /> : <div style={{ textAlign: 'center', padding: 40, color: '#7F8C8D', fontSize: 12 }}>{t('点击画布中的元件查看详情')}</div>}
      </div>
    </aside>
  );
}

/**
 * modules/app/TopNavigation.tsx — 顶栏：项目名 / 语言 / 导出 / 账户 / 导入（从 App.tsx 拆出）
 */
import { tr } from '../../shared/i18n';
import { importProjectFile } from '../../application/project-import';
import { hbtn } from '../../shared/ui-styles';
import { AccountBar } from '../../modules/account/AccountBar';
import { COLORS } from '../../shared/theme';
import type { CircuitCanvasDocument } from '../../design-core/document/types';
import type React from 'react';
import { dialogs } from '../ui/dialogStore';
/** 导入服务只返回"发生了什么"，提示留在 UI 层（application 不依赖 modules/ui） */
function showImportNotices(r: { notices: { level: 'success' | 'warning' | 'error'; text: string }[] }) {
  for (const n of r.notices) dialogs.toast(n.text, n.level);
}

export function TopNavigation({ buildStamp, doc, savedAt, lang, toggleLang, t, fileRef, ensureProjectName, renameProject, setPcbExportOpen }: { buildStamp: string, doc: CircuitCanvasDocument, savedAt: string | null, lang: string, toggleLang: () => void, t: (s: string) => string, fileRef: React.RefObject<HTMLInputElement>, ensureProjectName: () => Promise<boolean>, renameProject: () => Promise<void>, setPcbExportOpen: (v: boolean) => void }) {
  return (
    <header style={{ height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', background: '#fff', borderBottom: `2px solid ${COLORS.green}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 24 }}>⚡</span>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
          <span title={`build ${buildStamp}`} style={{ fontSize: 18, fontWeight: 700, color: COLORS.green, cursor: 'help' }}>{t('硬件原型工坊')}</span>
          <span style={{ fontSize: 10, color: '#94a3b8' }}>{t('AI 方案生成、器件选型与 PCB 预布局')}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" data-testid="project-name" onClick={() => void renameProject()}
          title={t('点击修改项目名称')}
          style={{ fontSize: 12, color: '#475569', background: '#f1f5f9', border: 'none', padding: '3px 10px', borderRadius: 6, cursor: 'pointer', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📁 {tr(doc.name)}</button>
        {savedAt && <span title={t('设计已自动保存在本浏览器（localStorage），导出设计可得到可分享的 JSON 文件')}
          style={{ fontSize: 10, color: '#94a3b8', alignSelf: 'center', marginRight: 4 }}>✓ {t('已自动保存')} {savedAt}</span>}
        <button data-testid="toggle-lang" onClick={toggleLang} title={lang === 'zh' ? 'Switch to English' : tr('切换为中文')}
          style={{ ...hbtn, fontWeight: 800 }}>{lang === 'zh' ? tr('中 | EN') : tr('EN | 中')}</button>
        {/* 「导出PCB」与「导出设计」合并为一个导出中心：PCB 工程 / 设计文件 / BOM / 报告 一处给全 */}
        <button data-testid="open-export" onClick={() => { void ensureProjectName().then((ok) => { if (ok) setPcbExportOpen(true); }); }} style={hbtn}>⬇ {t('导出设计')}</button>
        <AccountBar />
        <button onClick={() => fileRef.current?.click()} style={hbtn}>⬆ {t('导入设计')}</button>
        <input ref={fileRef} type="file" accept=".json,.kicad_pcb,.kicad_sch,.sch,.zip" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importProjectFile(f).then(showImportNotices); e.target.value = ''; }} />
      </div>
    </header>
  );
}

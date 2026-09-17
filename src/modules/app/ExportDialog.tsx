/**
 * modules/app/ExportDialog.tsx — 导出中心（设计 JSON / 报告 / BOM CSV / KiCad PCB）（从 App.tsx 拆出）
 */
import { useDesignStore } from '../../state/designStore';
import { downloadKicadPcb } from '../../modules/board-editor/pcbExport';
import { summarizeTrust, exportGate, trustLevelOf } from '../../design-core/trust';
import { tr } from '../../shared/i18n';
import { exportBomCsv } from '../../modules/bom/bom-csv';
import { exportDocument, exportMarkdownReport } from '../../modules/report/persistence';
import { COLORS } from '../../shared/theme';
import type { CircuitCanvasDocument } from '../../design-core/document/types';

export function ExportDialog({ doc, open, setOpen, t }: { doc: CircuitCanvasDocument; open: boolean; setOpen: (v: boolean) => void; t: (s: string) => string }) {
  if (!open) return null;
  return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={() => setOpen(false)}>
        <div style={{ width: '100%', maxWidth: 560, background: '#fff', borderRadius: 14, padding: 20, boxShadow: '0 24px 80px rgba(0,0,0,.25)' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.green, marginBottom: 4 }}>{tr('⬇ 导出设计')}</div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>{tr('PCB 工程、设计文件、BOM、方案报告在这里一次取全')}</div>
    
          {/* 其余产物：一键下载，不再散落在顶栏 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8, marginBottom: 12 }}>
            {([
              ['export-json', '📦 ' + t('设计文件 (JSON)'), t('完整设计，可再次导入本工具'), () => exportDocument(useDesignStore.getState().doc)],
              ['export-report', '📄 ' + t('方案报告 (MD)'), t('需求、器件清单、审查结论'), () => exportMarkdownReport(doc)],
              ['export-bom', '🧾 ' + t('BOM (CSV)'), t('位号、型号、封装、数量、单价'), () => exportBomCsv(doc)],
            ] as const).map(([tid, label, hint, fn]) => (
              <button key={label} data-testid={tid} onClick={() => fn()} title={hint}
                style={{ padding: '9px 10px', borderRadius: 8, border: '1px solid #E8F3EE', background: '#fff', textAlign: 'left', cursor: 'pointer' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.green }}>{label}</div>
                <div style={{ fontSize: 9.5, color: '#94a3b8', marginTop: 2 }}>{hint}</div>
              </button>
            ))}
          </div>
    
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#334155', marginBottom: 4 }}>{tr('🏭 PCB 布局文件')}</div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 10 }}>{tr('含板框（Edge.Cuts）、定位孔（非金属化孔）、全部器件真实焊盘与 Top/Bottom 层信息')}</div>
    
          {/* 未验证器件告警：AI 建议的型号不能不加提示地流入生产文件 */}
          {(() => {
            // 唯一口径：候选型号同样算未就绪 —— 此前只拦 PLACEHOLDER，
            // 一块全是 CANDIDATE 的板会静默导出成"没有告警"的样子
            const gate = exportGate(summarizeTrust(doc.components));
            if (gate.engineeringReady) return null;
            const unverified = doc.components.filter((x) => trustLevelOf(x) !== 'VERIFIED');
            return (
              <div style={{ padding: '10px 12px', borderRadius: 10, border: '1.5px solid #fecaca', background: '#fef2f2', marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#b91c1c' }}>
                  ⚠ {tr(gate.warning ?? '')}
                </div>
                <div style={{ fontSize: 10.5, color: '#991b1b', marginTop: 3 }}>
                  {tr('以下器件的型号未经器件库精确匹配核实（AI 建议、占位或近似候选），投产前必须人工确认：')}
                </div>
                <div style={{ fontSize: 10.5, color: '#7f1d1d', marginTop: 3, fontFamily: 'monospace' }}>
                  {unverified.slice(0, 12).map((x) => `${x.reference}(${x.mpn})`).join('  ')}
                  {unverified.length > 12 ? `  …+${unverified.length - 12}` : ''}
                </div>
              </div>
            );
          })()}
    
          <div style={{ padding: 12, borderRadius: 10, border: '1.5px solid #c6e2d0', background: '#f7fcf9', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{tr('KiCad（.kicad_pcb）· 兼容嘉立创EDA专业版')}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>{tr('KiCad 7+ 直接打开；嘉立创EDA专业版「文件 → 导入 → KiCad」同一文件即可。')}<b>{tr('导出为可继续编辑的初始工程，而非原工程的无损往返')}</b>{tr('：板框、器件位置、真实焊盘、网络表与导入工程的铜箔走线/过孔会保留；丝印、敷铜与规则设置不导出。画布上新建的设计没有走线，需在 KiCad 中布线。')}</div>
              </div>
              <button data-testid="export-kicad-pcb" onClick={() => { downloadKicadPcb(doc); setOpen(false); }} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: COLORS.green, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{tr('⬇ 下载')}</button>
            </div>
          </div>
    
          <div style={{ padding: 12, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Altium Designer</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{tr('.PcbDoc 为专有二进制格式，浏览器端无法直接生成。可行路径：较新版本 AD 的')} <b>File → Import Wizard</b> {tr('支持导入 KiCad 工程（若版本不支持，可先用 KiCad 打开再经转换工具迁移）。因此同样下载上方 KiCad 文件即可。')}</div>
          </div>
    
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={() => setOpen(false)} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', fontSize: 13, cursor: 'pointer' }}>{tr('关闭')}</button>
          </div>
        </div>
      </div>
  );
}

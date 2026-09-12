/**
 * modules/report/OverviewPanel.tsx
 * 方案概览 —— 把已有数据（设计意图、器件构成、板框、信任等级、BOM 估价）汇总成一页。
 * 不产生新结论：所有数字都来自文档现有字段。
 */
import { useDesignStore } from '../../state/designStore';
import { tr } from '../../shared/i18n';
import { COLORS } from '../../shared/theme';
import { TRUST_META } from '../../providers/ai-schema';
import { heightEnvelope } from '../../design-core/enclosure';

const card: React.CSSProperties = { background: '#fff', borderRadius: 12, border: '1px solid #E8F3EE', padding: 14 };
const h: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, color: COLORS.green, marginBottom: 8 };

const CAT_NAME: Record<string, string> = { mcu: '主控', power: '电源管理', connector: '对外接口', ic: '功能外设', passive: '无源器件' };

export function OverviewPanel() {
  const doc = useDesignStore((s) => s.doc);
  const select = useDesignStore((s) => s.select);
  const env = heightEnvelope(doc.components);

  const byCat = ['mcu', 'power', 'connector', 'ic', 'passive']
    .map((c) => ({ cat: c, list: doc.components.filter((x) => x.category === c) }))
    .filter((g) => g.list.length);

  const trustCount = (lv: 'VERIFIED' | 'CANDIDATE' | 'PLACEHOLDER') =>
    doc.components.filter((c) => (c.trust?.level ?? 'PLACEHOLDER') === lv).length;

  const netCount = Object.keys(doc.nets ?? {}).filter((k) => k !== '0').length;

  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%', background: '#f8fafc' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12, marginBottom: 12 }}>
        <div style={card}>
          <div style={h}>📋 {tr('设计需求')}</div>
          {doc.designIntent ? (
            <>
              <div style={{ fontSize: 12.5, color: '#2C3E50', lineHeight: 1.6, marginBottom: 8 }}>{doc.designIntent.requirement}</div>
              <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.6, padding: '8px 10px', background: '#f8fafc', borderRadius: 8 }}>
                <b>{tr('AI 选型理由')}：</b>{doc.designIntent.rationale}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.6 }}>
              {tr('手工搭建的方案，未记录需求描述。可在左侧「AI 生成方案」输入需求生成，或直接在此继续手工设计。')}
            </div>
          )}
        </div>

        <div style={card}>
          <div style={h}>📐 {tr('板级指标')}</div>
          {[
            [tr('板框尺寸'), `${doc.board.widthMm} × ${doc.board.heightMm} mm`],
            [tr('板形'), doc.board.shape],
            [tr('铜层'), (doc.copperLayers?.length ?? 2) + tr(' 层')],
            [tr('器件数'), `${doc.components.length}（TOP ${doc.components.filter((c) => c.placement.side === 'TOP').length} / BOTTOM ${doc.components.filter((c) => c.placement.side === 'BOTTOM').length}）`],
            [tr('网络数'), netCount ? String(netCount) : tr('未导入 netlist')],
            [tr('最高器件'), env.topTallest ? `${env.topTallest.reference} ${env.topMaxMm.toFixed(1)}mm` : '—'],
          ].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, padding: '3px 0', color: '#475569' }}>
              <span>{k}</span><b style={{ fontFamily: 'monospace', color: '#2C3E50' }}>{v}</b>
            </div>
          ))}
        </div>

        <div style={card}>
          <div style={h}>🔒 {tr('器件数据可信度')}</div>
          {(['VERIFIED', 'CANDIDATE', 'PLACEHOLDER'] as const).map((lv) => {
            const m = TRUST_META[lv];
            const n = trustCount(lv);
            return (
              <div key={lv} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <span style={{ fontSize: 9.5, padding: '2px 7px', borderRadius: 4, fontWeight: 700, background: m.bg, color: m.color }}>{tr(m.label)}</span>
                <span style={{ flex: 1, height: 6, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${doc.components.length ? (n / doc.components.length) * 100 : 0}%`, background: m.color }} />
                </span>
                <b style={{ fontSize: 11.5, minWidth: 22, textAlign: 'right' }}>{n}</b>
              </div>
            );
          })}
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6, lineHeight: 1.5 }}>
            {tr('VERIFIED 仅表示型号与器件库精确匹配，不代表电路设计已被验证。')}
          </div>
        </div>
      </div>

      <div style={card}>
        <div style={h}>🧩 {tr('方案构成')}</div>
        {!doc.components.length ? (
          <div style={{ fontSize: 11.5, color: '#94a3b8' }}>{tr('画布为空。用左侧搜索添加器件，或用 AI 生成方案。')}</div>
        ) : byCat.map((g) => (
          <div key={g.cat} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 5 }}>{tr(CAT_NAME[g.cat] ?? g.cat)}（{g.list.length}）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {g.list.map((c) => {
                const m = TRUST_META[c.trust?.level ?? 'PLACEHOLDER'];
                return (
                  <div key={c.instanceId} onClick={() => select(c.instanceId)} title={c.display?.description ?? ''}
                    style={{ padding: '5px 9px', borderRadius: 7, border: `1px solid ${m.color}33`, background: m.bg, cursor: 'pointer', fontSize: 11 }}>
                    <b style={{ color: COLORS.green }}>{c.reference}</b>{' '}
                    <span style={{ fontFamily: 'monospace' }}>{c.mpn}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

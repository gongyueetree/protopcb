/**
 * modules/component-search/ReferenceDesignSection.tsx
 * 器件详情右侧：应用项目 + 相关参考设计 + 提取功能块（Reference Design Intelligence P0 UI）。
 *
 * 诚实状态展示（方案 §四十七）：
 *   应用项目端点未接通 → 明确显示 BACKEND_NOT_CONNECTED 文案，绝不渲染假项目；
 *   参考设计走真实 /api/ezplm reference-designs，经统一模型 + 排序后渲染。
 * "提取功能块"是真实能力：对导入 KiCad 工程（带净表）围绕选中器件做图遍历提取，
 *   当前画布无连接性数据时如实提示，不假装提取成功。
 */
import { useEffect, useState } from 'react';
import type { PlacedComponent } from '../../design-core/document/types';
import { useDesignStore } from '../../state/designStore';
import { isEzplmPart } from '../../providers/ezplm-live';
import { getProviders } from '../../providers/factory';
import { useAccessContext } from '../../state/useAccessContext';
import type { ReferenceLoadResult as LoadResult } from '../../providers/types';
import { rankReferenceDesigns } from '../../providers/reference-design/ranking';
import type { ReferenceDesign, CircuitFragment } from '../../providers/reference-design/schema';
import { extractCircuitFragment } from '../../design-core/fragment/extract';
import { tr } from '../../shared/i18n';

const SRC_LABEL: Record<ReferenceDesign['sourceType'], string> = {
  USER_PROJECT: '我的项目', ORGANIZATION_PROJECT: '组织项目', EZPLM_PROJECT: 'ezPLM项目',
  VENDOR_REFERENCE: '厂商参考', EVALUATION_BOARD: '评估板', MODULE: '模块',
  KICAD_PROJECT: 'KiCad', ALTIUM_PROJECT: 'Altium', PDF_SCHEMATIC: 'PDF',
  DATASHEET_APPLICATION: '手册应用', GITHUB: 'GitHub', TINDIE: 'Tindie',
  SEEED: 'Seeed', HACKSTER: 'Hackster', HACKADAY: 'Hackaday', OTHER_PUBLIC: '公开',
};
const VER_LABEL: Record<ReferenceDesign['verification']['level'], { label: string; bg: string; color: string }> = {
  PRODUCTION_VERIFIED: { label: '量产验证', bg: '#dcfce7', color: '#166534' },
  PROTOTYPE_VERIFIED: { label: '原型实测', bg: '#dbeafe', color: '#1e40af' },
  SIMULATION_VERIFIED: { label: '仿真验证', bg: '#e0e7ff', color: '#3730a3' },
  VENDOR_REFERENCE: { label: '厂商参考', bg: '#fef9c3', color: '#854d0e' },
  EXTRACTED: { label: '提取', bg: '#f1f5f9', color: '#475569' },
  AI_GENERATED: { label: 'AI生成', bg: '#fee2e2', color: '#991b1b' },
};

function assetIcons(d: ReferenceDesign): string {
  const A = d.availableAssets;
  const parts: string[] = [];
  if (A.schematic) parts.push('SCH');
  if (A.pcb) parts.push('PCB');
  if (A.bom) parts.push('BOM');
  if (A.pdf) parts.push('PDF');
  if (A.step) parts.push('3D');
  if (A.simulation) parts.push('SIM');
  return parts.join(' · ');
}

function DesignCard({ d }: { d: ReferenceDesign }) {
  const ver = VER_LABEL[d.verification.level];
  const body = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#1e293b', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}{d.sourceUrl ? ' ↗' : ''}</span>
        <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, fontWeight: 700, background: '#f3e8ff', color: '#6b21a8' }}>{tr(SRC_LABEL[d.sourceType])}</span>
        <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, fontWeight: 700, background: ver.bg, color: ver.color }}>{tr(ver.label)}</span>
      </div>
      {(d.bomId || d.projectVersion || d.anchorQuantity) && (
        <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
          {d.bomId ? `${d.bomId} ` : ''}{d.projectVersion ? `${d.projectVersion} ` : ''}{d.anchorQuantity ? `· ${tr('用量')} ${d.anchorQuantity}` : ''}
        </div>
      )}
      {d.description && <div style={{ fontSize: 10, color: '#64748b', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.description}</div>}
      {assetIcons(d) && <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 2, fontWeight: 600 }}>{assetIcons(d)}</div>}
    </>
  );
  const style: React.CSSProperties = { display: 'block', padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #ede9fe', textDecoration: 'none' };
  return d.sourceUrl
    ? <a href={d.sourceUrl} target="_blank" rel="noreferrer" style={style}>{body}</a>
    : <div style={style}>{body}</div>;
}

export function ReferenceDesignSection({ c }: { c: PlacedComponent }) {
  const doc = useDesignStore((s) => s.doc);
  const ctx = useAccessContext();
  const [appProjects, setAppProjects] = useState<LoadResult>({ state: 'IDLE', items: [] });
  const [related, setRelated] = useState<LoadResult>({ state: 'IDLE', items: [] });
  const [fragment, setFragment] = useState<CircuitFragment | null>(null);
  const [fragMsg, setFragMsg] = useState('');

  useEffect(() => {
    setFragment(null); setFragMsg('');
    if (!isEzplmPart(c.componentId)) { setAppProjects({ state: 'IDLE', items: [] }); setRelated({ state: 'IDLE', items: [] }); return; }
    let alive = true;
    setAppProjects({ state: 'LOADING', items: [] });
    setRelated({ state: 'LOADING', items: [] });
    // 只能走 ProviderRegistry，且应用项目必须带真实身份（私有数据；匿名不发请求）
    const rd = getProviders().referenceDesigns;
    rd.getApplicationProjects(c.componentId, c.mpn, ctx).then((r) => { if (alive) setAppProjects(r); });
    rd.getRelatedReferenceDesigns(c.componentId, c.mpn, ctx).then((r) => { if (alive) setRelated(r); });
    return () => { alive = false; };
  }, [c.componentId, c.mpn]);

  const doExtract = () => {
    const out = extractCircuitFragment({ doc, anchorReference: c.reference });
    if (out.ok) {
      setFragment(out.fragment);
      setFragMsg('');
    } else {
      setFragment(null);
      setFragMsg(out.detail);
    }
  };

  const rankedApp = rankReferenceDesigns(appProjects.items, { mpn: c.mpn });
  const rankedRel = rankReferenceDesigns(related.items, { mpn: c.mpn });
  const showSection = isEzplmPart(c.componentId) || (doc.components.some((x) => x.reference === c.reference && x.display?.padNets));

  if (!showSection) return null;

  return (
    <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6d28d9', marginBottom: 6 }}>{tr('📐 参考设计智能')}</div>

      {/* ── 应用项目（私有：用户/组织历史项目） ── */}
      {isEzplmPart(c.componentId) && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: '#4c1d95', marginBottom: 4 }}>{tr('应用项目')}</div>
          {appProjects.state === 'LOADING' && <div style={{ fontSize: 10, color: '#94a3b8' }}>{tr('查询中…')}</div>}
          {appProjects.state === 'BACKEND_NOT_CONNECTED' && (
            <div style={{ fontSize: 10, color: '#92400e', background: '#fffbeb', border: '1px dashed #fcd34d', borderRadius: 6, padding: '5px 8px' }}>
              {tr('后端未接通')} — {appProjects.detail}
            </div>
          )}
          {appProjects.state === 'UNAUTHORIZED' && <div style={{ fontSize: 10, color: '#b91c1c' }}>{appProjects.detail}</div>}
          {appProjects.state === 'ERROR' && <div style={{ fontSize: 10, color: '#b91c1c' }}>{tr('查询失败：')}{appProjects.detail}</div>}
          {appProjects.state === 'READY' && (rankedApp.length
            ? (<>
                <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>{tr('你 / 当前组织有')} {rankedApp.length} {tr('个项目使用过该器件')}</div>
                {rankedApp.map((d) => <DesignCard key={d.id} d={d} />)}
              </>)
            : <div style={{ fontSize: 10, color: '#94a3b8' }}>{tr('暂无使用该器件的历史项目')}</div>)}
        </div>
      )}

      {/* ── 相关参考设计（公开来源） ── */}
      {isEzplmPart(c.componentId) && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: '#4c1d95', marginBottom: 4 }}>{tr('相关参考设计')}</div>
          {related.state === 'LOADING' && <div style={{ fontSize: 10, color: '#94a3b8' }}>{tr('查询中…')}</div>}
          {related.state === 'ERROR' && <div style={{ fontSize: 10, color: '#b91c1c' }}>{tr('查询失败：')}{related.detail}</div>}
          {related.state === 'READY' && (rankedRel.length
            ? (<>
                <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>{tr('找到')} {rankedRel.length} {tr('个公开设计（按可信度排序）')}</div>
                {rankedRel.map((d) => <DesignCard key={d.id} d={d} />)}
              </>)
            : <div style={{ fontSize: 10, color: '#94a3b8' }}>{tr('未找到公开参考设计')}</div>)}
        </div>
      )}

      {/* ── 提取功能块（真实能力：作用于当前画布的导入净表） ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: '#4c1d95' }}>{tr('功能块')}</div>
          <button onClick={doExtract} style={{ fontSize: 10, padding: '3px 10px', borderRadius: 5, border: '1px solid #c4b5fd', background: '#fff', color: '#6d28d9', fontWeight: 700, cursor: 'pointer' }}>
            {tr('围绕')} {c.reference} {tr('提取功能块')}
          </button>
        </div>
        {fragMsg && <div style={{ fontSize: 10, color: '#92400e', marginTop: 4 }}>{fragMsg}</div>}
        {fragment && (
          <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 6, background: '#fff', border: '1px solid #ede9fe' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#1e293b' }}>{fragment.name}</div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
              {fragment.components.length} {tr('个器件')} · {fragment.nets.length} {tr('个网络')} · {fragment.ports.length} {tr('个对外端口')}
            </div>
            <div style={{ fontSize: 10, color: '#475569', marginTop: 3, lineHeight: 1.6 }}>
              {fragment.components.map((fc) => `${fc.reference}(${fc.role === 'ANCHOR' ? tr('锚点') : fc.role === 'DECOUPLING' ? tr('去耦') : fc.role === 'CLOCK' ? tr('时钟') : fc.role === 'POWER_LOCAL' ? tr('电源') : fc.role === 'FILTER' ? tr('滤波') : tr('支撑')})`).join(' · ')}
            </div>
            {fragment.ports.length > 0 && (
              <div style={{ fontSize: 9.5, color: '#94a3b8', marginTop: 3 }}>
                {tr('端口：')}{fragment.ports.map((p) => p.name).join('、')}
              </div>
            )}
            <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3 }}>{tr('可信度：提取（净表事实 + 启发式边界）· 复用前请人工核对')}</div>
          </div>
        )}
      </div>
    </div>
  );
}

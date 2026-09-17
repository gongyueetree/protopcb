/**
 * modules/component-search/ComponentSearchPanel.tsx
 * 元器件搜索面板 —— 通过 ComponentDataProvider 检索，结果加入画布。
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getProviders } from '../../providers/factory';
import { searchSupplierParts, supplierPartToResult } from '../../application/parts';
import { searchEzplmParts, ezplmLiveAvailable } from '../../application/parts';

import { useT, useTranslated, tr } from '../../shared/i18n';
import { COLORS, fmtMoney } from '../../shared/theme';
import { filterAndRank, looksLikeMpn } from '../../design-core/part-match-policy';



import type { ComponentSearchResult } from '../../providers/types';
import type { ComponentCategory } from '../../design-core/document/types';
import { useAccessContext, anonymousContext } from '../../state/useAccessContext';
import { parseGenericPartQuery } from '../../design-core/semantics/generic-part-query';
import { useDesignStore } from '../../state/designStore';

/** 空结果提示块开关：当前关闭（保留 UI 以便后续启用） */
const SHOW_EMPTY_HINT: boolean = false;

const providers = getProviders();
// 身份来自 providers.identity（demo 模式自然是 demo-user，集成模式是真实身份）

export function ComponentSearchPanel() {
  const ctx = useAccessContext() ?? anonymousContext();
  const t = useT();
  const [keyword, setKeyword] = useState('');
  const [category] = useState<ComponentCategory | null>(null);
  const [orgOnly] = useState(false);
  /** 未登录只检索 ezPLM 器件库；分销商实时检索需要登录 */
  const [orgResults, setOrgResults] = useState<ComponentSearchResult[]>([]);
  const [ezplmResults, setEzplmResults] = useState<ComponentSearchResult[]>([]);
  const [netResults, setNetResults] = useState<ComponentSearchResult[]>([]);
  const [netBusy, setNetBusy] = useState(false);
  const [netMsg, setNetMsg] = useState('');
  const [srcTab, setSrcTab] = useState<'org' | 'ezplm' | 'net'>('ezplm');
  // 型号重合去重：ezPLM 已收录的型号不再出现在"网络" Tab（ezPLM 数据更权威）
  const ezplmMpns = new Set(ezplmResults.map((x) => x.mpn.toUpperCase()));
  const rawNet = netResults.filter((x) => !ezplmMpns.has(x.mpn.toUpperCase()));
  /**
   * 相关性门禁：上游按全文相关度返回，搜 CH340C 会混进 Servo PHAT / RFID Reader
   * 这类完全不相干的结果。查询串像型号时用 lookup 严格模式，否则 browse 放宽；
   * FUZZY 归入"相近候选"单独展示，REJECTED 一律不出现在正式结果里。
   */
  const netGate = useMemo(() => {
    const q = keyword.trim();
    if (!q) return { accepted: rawNet, nearby: [] as ComponentSearchResult[], rejected: 0 };
    const r = filterAndRank(q, rawNet.map((x) => ({
      mpn: x.mpn, description: x.description, category: x.category,
      footprint: x.defaultFootprintName, pins: x.pins, __src: x,
    })), looksLikeMpn(q) ? 'lookup' : 'browse');
    const pick = (g: typeof r.accepted) => g.map((x) => (x.item as unknown as { __src: ComponentSearchResult }).__src);
    return { accepted: pick(r.accepted), nearby: pick(r.nearby), rejected: r.rejected.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawNet, keyword]);
  const dedupedNet = netGate.accepted;
  // 有数据的源才显示 Tab（要求：无本组织数据不显示该 Tab，ezPLM 搜不到也不显示）
  const availTabs = ([
    orgResults.length ? 'org' : null,
    ezplmResults.length ? 'ezplm' : null,
    dedupedNet.length ? 'net' : null,
  ].filter(Boolean) as ('org' | 'ezplm' | 'net')[]);
  const results = srcTab === 'org' ? orgResults : srcTab === 'ezplm' ? ezplmResults : dedupedNet;

  /** 通用无源件查询（Cap / 100nF / 10k 0402）：库里搜不到，但我们能直接给一个标准件 */
  const generic = useMemo(() => parseGenericPartQuery(keyword), [keyword]);
  const addGeneric = (g: NonNullable<typeof generic>) => {
    useDesignStore.getState().addComponent({
      componentId: `generic_${g.kind}_${g.value ?? 'x'}_${g.size ?? 'def'}`,
      mpn: g.value ?? g.kind,
      manufacturer: '—',
      category: 'passive',
      defaultFootprintName: g.footprint,
      family: g.kind,
      description: tr('通用值器件'),
      pins: 2,
      source: 'KICAD',
      symbolFromMpn: g.symbol,
    } as never);
  };
  const setResults = setEzplmResults;   // 兼容既有赋值路径（ezPLM 主源）
  const [expanded, setExpanded] = useState<string | null>(null);
  const addComponent = useDesignStore((s) => s.addComponent);
  const components = useDesignStore((s) => s.doc.components);
  const placedCount = useMemo(() => {
    const m = new Map<string, number>();
    components.forEach((c) => m.set(c.componentId, (m.get(c.componentId) ?? 0) + 1));
    return m;
  }, [components]);

  const [liveStatus, setLiveStatus] = useState<'unknown' | 'live' | 'demo'>('unknown');
  const [searchErr, setSearchErr] = useState<'none' | 'network' | 'empty'>('none');
  useEffect(() => { ezplmLiveAvailable().then((ok) => setLiveStatus(ok ? 'live' : 'demo')); }, []);

  // 竞态守卫：只采纳最新一次请求的结果（快速输入时旧请求可能后返回，会覆盖正确结果）
  const searchSeq = useRef(0);

  const runSearch = useCallback(async () => {
    const seq = ++searchSeq.current;
    const q = keyword.trim();
    // ── 本组织物料（orgOnly 检索）与 网络（DigiKey/Mouser）并行拉取 ──
    if (q) {
      // 本组织物料是私有数据：匿名不发请求（也没有租户可查）
      if (ctx?.userId) {
        providers.components.searchComponents({ keyword: q, orgOnly: true }, ctx)
          .then((r: { items: ComponentSearchResult[] }) => { if (seq === searchSeq.current) setOrgResults(r.items ?? []); })
          .catch(() => { if (seq === searchSeq.current) setOrgResults([]); });
      } else {
        setOrgResults([]);
      }
      {
      setNetBusy(true); setNetMsg('');
      searchSupplierParts(q, 10)
        .then((r) => {
          if (seq !== searchSeq.current) return;
          setNetResults(r.items.map(supplierPartToResult));   // 渲染时再按 ezPLM 去重（见 dedupedNet）
          setNetMsg(r.items.length ? '' : (r.message ?? ''));
          setNetBusy(false);
        })
        .catch(() => { if (seq === searchSeq.current) { setNetResults([]); setNetBusy(false); } });
      }
    } else {
      setOrgResults([]); setNetResults([]); setNetMsg('');
    }
    // 关键词检索优先走 ezPLM 实时库（需 Vercel 配置 EZPLM_API_KEY）
    // 勾选「仅显示本组织物料」时跳过实时库（系统库物料不属于组织物料）
    if (keyword.trim() && !orgOnly) {
      let live: Awaited<ReturnType<typeof searchEzplmParts>>;
      try {
        live = await searchEzplmParts(keyword.trim());
      } catch {
        if (seq === searchSeq.current) setSearchErr('network');
        live = { available: false, items: [] } as typeof live;
      }
      if (seq !== searchSeq.current) return; // 已有更新的请求，丢弃本次结果
      setSearchErr(live.available && !live.items.length ? 'empty' : 'none');
      if (live.available && live.items.length) {
        const filtered = category ? live.items.filter((i) => i.category === category) : live.items;
        setResults(filtered);
        return;
      }
    }
    // 无关键词且未选分类：不转储默认目录，显示引导空态（避免"17 个预设"误导）
    if (!keyword.trim() && !category && !orgOnly) {
      if (seq === searchSeq.current) { setResults([]); setSearchErr('none'); }
      return;
    }
    // 型号搜索专注 ezPLM 库；通用封装从「KiCad封装库」tab 取
    let res: { items: ComponentSearchResult[] };
    try {
      res = await providers.components.searchComponents({ keyword, category: category ?? undefined, orgOnly }, ctx);
    } catch {
      res = { items: [] };
    }
    if (seq !== searchSeq.current) return;
    setResults(res.items);
  // 身份与网络权限变化都要重跑：登录后本组织与分销商结果才会出现
  }, [keyword, category, orgOnly, ctx?.userId, ctx?.organizationId]);

  // 当前 Tab 无结果时自动切到有结果的源（避免用户看到空白误以为没搜到）
  useEffect(() => {
    if (!availTabs.length) return;
    if (!availTabs.includes(srcTab)) setSrcTab(availTabs[0]);
  }, [availTabs.join(','), srcTab]);

  // 300ms 防抖：停止输入后才发请求（避免竞态 + 节省 ezPLM 每日调用配额）
  useEffect(() => {
    const t = setTimeout(runSearch, 300);
    return () => clearTimeout(t);
  }, [runSearch]);

  return (
    <div>
      {liveStatus !== 'unknown' && (
        <div style={{ fontSize: 10, marginBottom: 8, padding: '4px 8px', borderRadius: 6, background: liveStatus === 'live' ? '#f0fdf4' : '#f8fafc', border: `1px solid ${liveStatus === 'live' ? '#bbf7d0' : '#e2e8f0'}`, color: liveStatus === 'live' ? '#16a34a' : '#94a3b8', fontWeight: 600 }}>
          {liveStatus === 'live' ? '✓ ' + t('已连接 ezPLM 元器件库（实时检索）') : '内置演示数据 · 在 Vercel 配置 EZPLM_API_KEY 后接入实时库'}
        </div>
      )}
      <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={t('搜索型号、封装、关键词...')}
        style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid #dbe6dd', fontSize: 13, outline: 'none', boxSizing: 'border-box', marginBottom: 10 }} />
      {/* 三源 Tab：本组织 / ezPLM / 网络（DigiKey+Mouser）；无数据的源不显示 Tab */}
      {keyword.trim() && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          {availTabs.map((tb) => (
            <button key={tb} onClick={() => setSrcTab(tb)}
              style={{ flex: 1, padding: '5px 0', borderRadius: 6, border: '1px solid ' + (srcTab === tb ? COLORS.green : '#dbe6dd'), background: srcTab === tb ? COLORS.greenBg : '#fff', color: srcTab === tb ? COLORS.green : '#64748b', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
              {tb === 'org' ? tr('本组织') : tb === 'ezplm' ? 'ezPLM' : tr('网络')}
              <span style={{ marginLeft: 4, fontSize: 9.5, opacity: .75 }}>{tb === 'org' ? orgResults.length : tb === 'ezplm' ? ezplmResults.length : dedupedNet.length}</span>
            </button>
          ))}
          {netBusy && <span style={{ alignSelf: 'center', fontSize: 10, color: '#94a3b8' }}>⟳</span>}
        </div>
      )}
      {/* 通用无源件：Cap / 100nF / 10k 0402 这类查询在库里搜不到（它们是值不是型号），
          直接给一个 KiCad 官方符号+封装的通用件，并如实标注"通用值器件" */}
      {generic && (
        <div style={{ marginBottom: 8, padding: 10, borderRadius: 10, border: '1px solid #bbf7d0', background: '#f0fdf4' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#166534', fontFamily: 'monospace' }}>{generic.label}</div>
              <div style={{ fontSize: 10, color: '#4d7c0f', marginTop: 2 }}>
                {tr('通用值器件')} · {generic.symbol} · {tr('无需型号验证；后续可用「按参数选型」换成具体型号')}
              </div>
            </div>
            <button onClick={() => addGeneric(generic)}
              style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: COLORS.green, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              + {tr('放到画布')}
            </button>
          </div>
        </div>
      )}
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>{t('找到')} {results.length} {t('个结果')}</div>
      {results.length === 0 && keyword.trim() === '' && (
        <div style={{ padding: '14px 12px', borderRadius: 8, background: '#f8fafc', border: '1px dashed #e2e8f0', fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>
          {tr('输入型号/关键词检索 ezPLM 实时库；通用封装请用「KiCad封装库」tab')}
        </div>
      )}
      {!availTabs.length && keyword.trim() !== '' && !netBusy && (
        <div style={{ padding: '10px 12px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', fontSize: 11, color: '#92400e', marginBottom: 8 }}>
          {tr('本组织、ezPLM 与网络（DigiKey/Mouser）均未查询到结果')}
          {netGate.rejected > 0 && (
            <div style={{ marginTop: 4, fontSize: 10, color: '#b45309' }}>
              {tr('网络返回的')} {netGate.rejected} {tr('条结果与该型号相关性过低，已过滤')}
            </div>
          )}
          {netMsg && <div style={{ marginTop: 3, fontSize: 10, color: '#a16207' }}>{netMsg}</div>}
        </div>
      )}
      {SHOW_EMPTY_HINT && results.length === 0 && keyword.trim() !== '' && (
        <div style={{ padding: '10px 12px', borderRadius: 8, background: searchErr === 'network' ? '#fef2f2' : '#fffbeb', border: `1px solid ${searchErr === 'network' ? '#fecaca' : '#fde68a'}`, fontSize: 11, color: searchErr === 'network' ? '#b91c1c' : '#92400e', marginBottom: 8 }}>
          {searchErr === 'network'
            ? t('网络或服务异常，请稍后重试；若持续失败请检查 Vercel 的 EZPLM_API_KEY 配置')
            : liveStatus === 'demo'
              ? t('演示目录未收录该型号 —— 配置 EZPLM_API_KEY 接入实时库，或用「定制模块」自行创建')
              : t('ezPLM 库未收录该型号 —— 可换关键词，或用「定制模块」上传 datasheet 创建')}
        </div>
      )}
      {results.map((r) => (
        <ResultCard key={r.componentId} r={r} expanded={expanded === r.componentId}
          onToggle={() => setExpanded(expanded === r.componentId ? null : r.componentId)}
          onAdd={() => addComponent(r)} placedN={placedCount.get(r.componentId) ?? 0} />
      ))}
    </div>
  );
}

function ResultCard({ r, expanded, onToggle, onAdd, placedN }: {
  r: ComponentSearchResult; expanded: boolean; onToggle: () => void; onAdd: () => void; placedN: number;
}) {
  const t = useT();
  const isOrg = !!r.org;
  return (
    <div style={{ marginBottom: 8, borderRadius: 8, border: `1px solid ${isOrg ? '#c6e2d0' : '#e5e7eb'}`, background: isOrg ? '#f0f9f4' : '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', gap: 8, cursor: 'pointer' }} onClick={onToggle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {r.componentId.startsWith('ez_') ? <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#e0f2fe', color: '#0369a1', fontWeight: 700 }}>ezPLM</span>
              : isOrg ? <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#dcfce7', color: '#166534', fontWeight: 600 }}>{t('本组织')}</span> : null}
            <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.mpn}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 3, fontSize: 11, color: '#6b7280', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'monospace' }}>{r.defaultFootprintName}</span><span>·</span><span>{t(r.manufacturer)}</span>
            {r.unitPrice != null && <><span>·</span><span style={{ color: '#047857', fontWeight: 700 }}>{fmtMoney(r.unitPrice.amount, r.unitPrice.currency)}</span></>}
          </div>
          {r.description && <TrText text={r.description} style={{ marginTop: 2, fontSize: 10.5, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} />}
        </div>
        {placedN > 0 && <span title={tr('画布上已有该型号，可重复添加')} style={{ fontSize: 9.5, padding: '1px 6px', borderRadius: 8, background: '#ecfdf5', color: '#059669', fontWeight: 700 }}>×{placedN}</span>}
        <button onClick={(e) => { e.stopPropagation(); onAdd(); }} style={addBtn}>+</button>
        <span style={{ fontSize: 10, color: '#64748b' }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '0 12px 12px', borderTop: '1px solid #e5e7eb', fontSize: 11, color: '#475569' }}>
          <TrText text={r.description ?? ''} style={{ margin: '8px 0' }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
            <div>{tr('封装：')}{r.defaultFootprintName}</div><div>{tr('引脚：')}{r.pins ?? '—'}</div>
            <div>{tr('族：')}{r.family}</div><div>{tr('厂商：')}{r.manufacturer}</div>
          </div>
          {r.org && <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 6, background: '#f0f9f4', fontSize: 10 }}>
            {tr('内部料号')} {r.org.internalPartNumber} · 库存 {r.org.stockQuantity} · 已用于 {r.org.projectUsageCount} {tr('个项目')}
          </div>}
        </div>
      )}
    </div>
  );
}

const _chip = (active: boolean): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 16, fontSize: 11, fontWeight: 600, cursor: 'pointer',
  border: `1px solid ${active ? COLORS.green : '#dbe6dd'}`, background: active ? COLORS.greenBg : '#fff', color: active ? COLORS.green : '#64748b',
});
const addBtn: React.CSSProperties = { width: 28, height: 28, borderRadius: 6, border: 'none', background: COLORS.green, color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };

/** 动态文本（ezPLM 中文数据）：英文模式下自动翻译并缓存 */
function TrText({ text, style }: { text: string; style?: React.CSSProperties }) {
  const tr = useTranslated(text);
  return <div style={style}>{tr}</div>;
}

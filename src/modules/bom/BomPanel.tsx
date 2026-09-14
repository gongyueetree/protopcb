/**
 * modules/bom/BomPanel.tsx
 * BOM 清单 —— 从 store 的 doc.bom 渲染，支持 CSV 导出。
 */
import { tr, currencySym, curLang } from '../../shared/i18n';
import { useDesignStore } from '../../state/designStore';
import { fmtMoney, COLORS } from '../../shared/theme';
import { useEffect, useRef, useState } from 'react';
import type { BomLine } from '../../design-core/document/types';
import { geminiAvailable } from '../../providers/gemini';
import { aiRequest, extractJson } from '../../providers/ai-client';
import { isPriceable, whyNotPriceable, classifyByRefDes, pricingPriority, CLASS_LABEL } from './part-class';
import { fetchDigikeyOffer, type DigikeyOffer } from '../../providers/digikey';
import { fetchSupplierOffers } from '../../providers/suppliers';
import { buildMatchQuery, rankCandidates, parseConstraints, CLASS_LABEL as PART_CLASS_LABEL, type Candidate, type ScoredCandidate } from '../../design-core/part-matching';
import { autoMatchBom, summarizeMatches, type BomMatchResult } from './auto-match';
import { summarizeBomPricing } from './pricing-summary';
import { searchEzplmParts } from '../../providers/ezplm-live';
import { useEntitlementStore } from '../../state/entitlementStore';
import { AiGateNotice } from '../account/AccountBar';
import type { DenyReason } from '../../design-core/entitlements';

export function BomPanel({ isFullscreen, onToggleFullscreen }: { isFullscreen?: boolean; onToggleFullscreen?: () => void } = {}) {
  const bom = useDesignStore((s) => s.doc.bom);
  const components = useDesignStore((s) => s.doc.components);
  const srcOf = (ref: string) => components.find((c) => c.reference === ref)?.source;

  // DigiKey 实时价格：逐型号查询（provider 内按 mpn 缓存，避免重复消耗配额）
  const [dkPrices, setDkPrices] = useState<Record<string, DigikeyOffer>>({});
  /** DigiKey 无结果时的其他渠道报价（Mouser/Arrow/element14） */
  const [netPrices, setNetPrices] = useState<Record<string, { vendor: string; price: number; currency?: string; stock?: number }>>({});
  /** 已查询完成的型号（无论有无结果）—— 用于把"查询中…"落定为"无报价" */
  const [queried, setQueried] = useState<Record<string, true>>({});
  /** 无报价行的人工查价：模糊候选列表（用户点选后作为录入价） */
  const [market, setMarket] = useState<{ busy: boolean; low?: number; high?: number; typical?: number; basis?: string; msg?: string } | null>(null);
  const [fuzzy, setFuzzy] = useState<{ line: BomLine; busy: boolean; items: ScoredCandidate[]; msg?: string; query?: ReturnType<typeof buildMatchQuery>; searchMpn?: string; cons?: string } | null>(null);
  /** 对话框里可改写的型号 —— 用户原始命名常常不完整（如 9012 → S9012、MachXO2-1200-QFN32 → LCMXO2-1200HC-4SG32C）。
   *  用非受控 input + ref：受控写法会因每次按键触发整个面板重渲染，且易被祖先的 mousedown/keydown 处理器干扰。 */
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** 批量关联：结果按位号索引，供表格逐行展示 */
  const [autoRes, setAutoRes] = useState<Record<string, BomMatchResult>>({});
  const [autoBusy, setAutoBusy] = useState<{ done: number; total: number } | null>(null);
  const checkCap = useEntitlementStore((s) => s.check);
  const [aiGate, setAiGate] = useState<{ reason: DenyReason; cost?: number } | null>(null);
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });

  /**
   * 一键关联：ezPLM → 分销商 → AI 估价。
   * 只填充"匹配结果与价格"，**不自动改写设计里的型号** —— 近似料必须人工确认。
   */
  const runAutoMatch = async () => {
    if (autoBusy) { abortRef.current.aborted = true; return; }
    const signal = { aborted: false };
    abortRef.current = signal;
    setAutoBusy({ done: 0, total: bom.length });
    const aiOk = await geminiAvailable().catch(() => false);
    // 估价是 AI 能力：没登录/额度不够就只跑 ezPLM 与分销商，
    // 并在结束后说明"估价未启用"，而不是静默少一列价格
    const estGate = checkCap('bom.estimate');
    const estimateAllowed = estGate.allowed;
    if (!estimateAllowed) setAiGate({ reason: estGate.reason!, cost: estGate.cost });
    const results = await autoMatchBom(
      bom.map((l) => ({ reference: l.reference, mpn: l.mpn, footprint: l.footprint, description: l.description, quantity: l.quantity })),
      {
        searchEzplm: async (q, limit) => {
          const r = await searchEzplmParts(q, limit);
          return r.available ? r.items.map((it) => ({
            mpn: it.mpn, manufacturer: it.manufacturer, description: it.description,
            footprint: it.defaultFootprintName, category: it.category, source: 'ezplm' as const,
          })) : [];
        },
        searchDistributors: async (q) => {
          const out: Candidate[] = [];
          if (!checkCap('search.web').allowed) return out;   // 未登录：不打分销商
          for (const url of [`/api/digikey?path=fuzzy&q=${encodeURIComponent(q)}`, `/api/suppliers?path=fuzzy&q=${encodeURIComponent(q)}&mpn=${encodeURIComponent(q)}`]) {
            try {
              const j = await (await fetch(url)).json();
              for (const it of (Array.isArray(j.items) ? j.items : [])) {
                out.push({ mpn: it.mpn, manufacturer: it.manufacturer, description: it.description,
                  source: 'distributor', vendor: it.vendor, price: it.price, currency: it.currency, stock: it.stock, url: it.url });
              }
              if (out.length) break;
            } catch { /* 换下一家 */ }
          }
          return out;
        },
        // AI 估价只在前两步都没有价格时触发，结果显式标注为估算
        // AI 估价同样受门禁约束：批量跑之前先判一次，避免逐行弹提示
        estimatePrice: aiOk && estimateAllowed ? async (l) => {
          // 每一行都是一次独立的 bom.estimate（固定 1 Credit，服务端计费）
          const { text: txt } = await aiRequest('bom.estimate', {
            reference: l.reference, mpn: l.mpn, footprint: l.footprint, description: l.description, lang: curLang(),
          });
          const m = txt.match(/\{[\s\S]*\}/);
          if (!m) return null;
          const j = JSON.parse(m[0]) as { cny?: number; note?: string };
          return typeof j.cny === 'number' && j.cny > 0 ? { amount: j.cny, currency: 'CNY', note: j.note ?? 'AI 估算' } : null;
        } : undefined,
      },
      {
        concurrency: 3,
        signal,
        onProgress: (done, total, last) => {
          setAutoBusy({ done, total });
          if (last) setAutoRes((prev) => ({ ...prev, [last.reference]: last }));
        },
      },
    );
    setAutoRes(Object.fromEntries(results.map((r) => [r.reference, r])));
    setAutoBusy(null);
  };
  /** 用户补充的选型约束（国产优先 / 1元以内 / 不要阵列…），确定性解析后参与打分与过滤 */
  const consInputRef = useRef<HTMLInputElement>(null);

  /**
   * 智能匹配：由位号（类别）+ 封装（族/尺寸）+ 型号或描述（值/关键词）构造检索计划，
   * **先查 ezPLM 自有器件库，再查分销商**，合并打分排序后交用户确认。
   * 候选永不自动写回设计 —— 与 AI trust 同一条原则。
   */
  const openFuzzy = async (l: BomLine, mpnOverride?: string, consText?: string) => {
    setMarket(null);
    const searchMpn = (mpnOverride ?? l.mpn ?? '').trim();
    const query = buildMatchQuery({ reference: l.reference, mpn: searchMpn, footprint: l.footprint, description: l.description });
    const cons = parseConstraints(consText ?? consInputRef.current?.value ?? '');
    setFuzzy({ line: l, busy: true, items: [], query, searchMpn, cons: cons.raw });
    const pool: Candidate[] = [];
    const notes: string[] = [];

    // 1) ezPLM 优先：按检索计划前两条查询串各取若干
    try {
      for (const q of query.queries.slice(0, 2)) {
        const r = await searchEzplmParts(q, 8);
        if (!r.available) { notes.push('ezPLM 未连接'); break; }
        for (const it of r.items) {
          pool.push({
            mpn: it.mpn, manufacturer: it.manufacturer, description: it.description,
            footprint: it.defaultFootprintName, category: it.category, source: 'ezplm',
          });
        }
        if (pool.length >= 8) break;
      }
    } catch { notes.push('ezPLM 查询失败'); }

    // 2) 分销商补充（用平台 Key：未登录不发请求，服务端本来也会 401）
    const webOk = checkCap('search.web').allowed;
    if (!webOk) notes.push('登录后可查询 DigiKey / Mouser 实时库存与价格');
    if (webOk) try {
      const qs = new URLSearchParams({ path: 'fuzzy', mpn: searchMpn, footprint: l.footprint ?? '', desc: l.description ?? '', q: query.queries[0] ?? '' });
      const r = await fetch(`/api/suppliers?${qs}`);
      const j = await r.json();
      for (const it of (Array.isArray(j.items) ? j.items : [])) {
        pool.push({
          mpn: it.mpn, manufacturer: it.manufacturer, description: it.description, source: 'distributor',
          vendor: it.vendor, price: it.price, currency: it.currency, stock: it.stock, url: it.url,
        });
      }
      if (j.message) notes.push(String(j.message));
    } catch (e) { notes.push((e as Error).message); }

    // 3) DigiKey 关键词检索：用户填写的型号优先，其次是构造出的检索串
    if (webOk) try {
      for (const kw of [searchMpn, query.queries[0]].filter(Boolean).slice(0, 2)) {
        const r = await fetch(`/api/digikey?path=fuzzy&q=${encodeURIComponent(kw as string)}`);
        const j = await r.json();
        for (const it of (Array.isArray(j.items) ? j.items : [])) {
          pool.push({
            mpn: it.mpn, manufacturer: it.manufacturer, description: it.description, source: 'distributor',
            vendor: 'DigiKey', price: it.price, currency: it.currency, stock: it.stock, url: it.url,
          });
        }
        if (j.message) notes.push(`DigiKey: ${j.message}`);
        if (pool.some((x) => x.vendor === 'DigiKey')) break;
      }
    } catch (e) { notes.push((e as Error).message); }

    const ranked = rankCandidates(query, pool, cons).slice(0, 12);
    setFuzzy({ line: l, busy: false, items: ranked, query, searchMpn, cons: cons.raw, msg: ranked.length ? (notes.length ? notes.join(' · ') : undefined) : ((notes.length ? notes.join(' · ') + '；' : '') + '未找到相近器件；可在上方修改型号后重新检索') });
  };

  /** 网络参考价：AI 按公开市场行情给区间。明确标注为估算，必须人工确认后才落为录入价。 */
  const askMarketPrice = async (l: BomLine) => {
    // 市场价属于 AI 估价能力
    const g = checkCap('bom.estimate');
    if (!g.allowed) { setAiGate({ reason: g.reason!, cost: g.cost }); return; }
    setMarket({ busy: true });
    try {
      const raw = (await aiRequest('bom.estimate', {
        reference: l.reference, mpn: l.mpn, footprint: l.footprint, description: l.description, lang: curLang(),
      })).text;
      const j = extractJson<{ low?: number; high?: number; typical?: number; basis?: string; confident?: boolean }>(raw);
      if (!j.confident || j.typical == null) {
        setMarket({ busy: false, msg: '无法判断该器件的市场价，请手工录入' });
        return;
      }
      setMarket({ busy: false, low: j.low, high: j.high, typical: j.typical, basis: j.basis });
    } catch (e) {
      setMarket({ busy: false, msg: (e as Error).message });
    }
  };
  useEffect(() => {
    let alive = true;
    (async () => {
      // 先 IC/模块，再晶体管/二极管，最后无源件；结构件与"值不是型号"的行根本不查
      const queue = bom
        .filter((l) => isPriceable(l.mpn, l.reference, l.footprint))
        .sort((a, b) => pricingPriority(classifyByRefDes(a.reference, a.footprint, a.mpn))
          - pricingPriority(classifyByRefDes(b.reference, b.footprint, b.mpn)));
      for (const l of queue) {
        if (dkPrices[l.mpn] || netPrices[l.mpn]) continue;
        const o = await fetchDigikeyOffer(l.mpn);
        if (!alive) return;
        if (o?.found && o.unitPrice != null) { setDkPrices((prev) => ({ ...prev, [l.mpn]: o })); setQueried((prev) => ({ ...prev, [l.mpn]: true })); continue; }
        // DigiKey 未收录 → 回落其他供应商 API，真正落实"网络估价"
        const offers = await fetchSupplierOffers(l.mpn);
        if (!alive) return;
        const best = offers.filter((x) => x.found && x.price != null).sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];
        if (best) setNetPrices((prev) => ({ ...prev, [l.mpn]: { vendor: best.vendor, price: best.price!, currency: best.currency, stock: best.stock } }));
        setQueried((prev) => ({ ...prev, [l.mpn]: true }));
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bom]);
  const dkOf = (mpn: string): DigikeyOffer | undefined => dkPrices[mpn];
  const netOf = (mpn: string) => netPrices[mpn];
  /** 手工录入价（优先级最高，来源显示「录入」；localStorage 持久化，切 Tab/刷新不丢） */
  const docId = useDesignStore((st) => st.doc.id);
  const [manualPrices, setManualPrices] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('cc_manual_price_' + docId) ?? '{}'); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem('cc_manual_price_' + docId, JSON.stringify(manualPrices)); } catch { /* 空间不足忽略 */ }
  }, [manualPrices, docId]);
  const setComponentMpn = useDesignStore((s) => s.setComponentMpn);
  /**
   * 采用候选型号：把该 BOM 行涉及的器件型号改为候选型号。
   * trust 由 store 侧按"用户手工指定"处理，不会因为来自 ezPLM 搜索就标成 VERIFIED。
   */
  const adoptMpn = (line: BomLine, cand: ScoredCandidate) => {
    // BOM 行按型号聚合（位号列可能是 "R2, R3, R6 +5" 这种省略写法），
    // 所以按型号找出全部器件实例，而不是解析位号串。
    const targets = components.filter((c) => c.mpn === line.mpn);
    for (const comp of targets) setComponentMpn(comp.instanceId, cand.mpn, cand.manufacturer);
    if (cand.price != null) setManualPrices((prev) => ({ ...prev, [cand.mpn]: cand.price as number }));
  };

  const [editingMpn, setEditingMpn] = useState<string | null>(null);
  const manOf = (mpn: string): number | undefined => manualPrices[mpn];

  /** RFC 4180：含逗号/双引号/换行的字段用双引号包裹，内部双引号写成两个 */
  const csvField = (v: unknown): string => {
    const t = String(v ?? '');
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const exportCsv = () => {
    const header = '序号,位号,型号,厂商,封装,单价,价格来源,数量';
    const rows = bom.map((l, i) => [
      i + 1, l.reference, l.mpn, l.manufacturer, l.footprint,
      manOf(l.mpn) ?? dkOf(l.mpn)?.unitPrice ?? netOf(l.mpn)?.price ?? l.unitPrice?.amount ?? '',
      manOf(l.mpn) != null ? tr('录入') : dkOf(l.mpn) ? '网络价格(DigiKey)' : netOf(l.mpn) ? `网络价格(${netOf(l.mpn)!.vendor})` : '',
      l.quantity,
    ].map(csvField).join(','));
    const csv = '\uFEFF' + [header, ...rows].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'bom.csv';
    a.click();
  };

  const fuzzyModal = fuzzy && (
    <div onClick={() => setFuzzy(null)}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(560px, 96vw)', maxHeight: '78vh', overflow: 'auto', background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 12px 40px rgba(15,23,42,.2)' }}>
        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 2 }}>{tr('查找相近器件')} · {fuzzy.line.reference}</div>
        <div style={{ fontSize: 10.5, color: '#64748b', marginBottom: 10 }}>
          {[fuzzy.line.mpn, fuzzy.line.footprint].filter(Boolean).join(' · ')}
          {fuzzy.query && (
            <span style={{ marginLeft: 6 }}>
              → {tr('识别为')} <b>{tr(PART_CLASS_LABEL[fuzzy.query.partClass])}</b>
              {fuzzy.query.footprint.size ? ` · ${fuzzy.query.footprint.size}` : ''}
              {fuzzy.query.footprint.family ? ` · ${fuzzy.query.footprint.family}${fuzzy.query.footprint.pins ? '-' + fuzzy.query.footprint.pins : ''}` : ''}
              {fuzzy.query.value.value ? ` · ${tr('值')} ${fuzzy.query.value.value}` : ''}
            </span>
          )}
          <div style={{ marginTop: 3, color: '#b45309' }}>{tr('候选由位号类别 + 封装 + 值/关键词匹配得出，需人工确认后才写回设计')}</div>
        </div>
        {/* 改写型号重新检索：原理图里的名称常常不是可采购的完整型号 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 9px', marginBottom: 8, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
          <span style={{ fontSize: 10.5, color: '#475569', fontWeight: 700, whiteSpace: 'nowrap' }}>{tr('检索型号')}</span>
          <input
            ref={searchInputRef}
            key={fuzzy.line.reference}
            autoFocus
            defaultValue={fuzzy.searchMpn ?? fuzzy.line.mpn}
            placeholder={tr('填写完整的制造商料号后重新检索')}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();                       // 避免被上层快捷键处理器吞掉
              if (e.key === 'Enter') {
                const v = (e.target as HTMLInputElement).value.trim();
                if (v) openFuzzy(fuzzy.line, v);
              }
            }}
            style={{ flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 11.5, fontFamily: 'monospace', outline: 'none' }} />
          <button onClick={() => openFuzzy(fuzzy.line, (searchInputRef.current?.value.trim() || fuzzy.line.mpn))} disabled={fuzzy.busy}
            style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: '#1f5c3b', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: fuzzy.busy ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
            {fuzzy.busy ? '⟳' : tr('重新检索')}
          </button>
        </div>
        {/* 选型约束：确定性解析（价格上限、国产/车规偏好、排除阵列），命中理由会显示在候选上 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 9px', marginBottom: 8, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
          <span style={{ fontSize: 10.5, color: '#475569', fontWeight: 700, whiteSpace: 'nowrap' }}>{tr('选型约束')}</span>
          <input
            ref={consInputRef}
            defaultValue={fuzzy.cons ?? ''}
            placeholder={tr('如：国产优先、1元以内、不要阵列、车规')}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') openFuzzy(fuzzy.line, searchInputRef.current?.value.trim() || fuzzy.line.mpn, (e.target as HTMLInputElement).value);
            }}
            style={{ flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 11.5, outline: 'none' }} />
          <button onClick={() => openFuzzy(fuzzy.line, searchInputRef.current?.value.trim() || fuzzy.line.mpn, consInputRef.current?.value)} disabled={fuzzy.busy}
            style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', fontSize: 10.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {tr('应用约束')}
          </button>
        </div>
        {fuzzy.busy && <div style={{ fontSize: 11.5, color: '#64748b' }}>{tr('检索中…')}</div>}
        {!fuzzy.busy && !fuzzy.items.length && <div style={{ fontSize: 11.5, color: '#92400e' }}>{tr(fuzzy.msg || '未找到相近器件')}</div>}
        {fuzzy.items.map((it, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', marginBottom: 5, borderRadius: 7, border: `1px solid ${it.source === 'ezplm' ? '#bbf7d0' : '#e2e8f0'}`, background: it.source === 'ezplm' ? '#f0fdf4' : '#fff' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11.5, fontWeight: 700 }}>{it.mpn}</span>
                <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, fontWeight: 700, background: it.source === 'ezplm' ? '#dcfce7' : '#e0f2fe', color: it.source === 'ezplm' ? '#166534' : '#0369a1' }}>
                  {it.source === 'ezplm' ? 'ezPLM' : (it.vendor ?? tr('分销商'))}
                </span>
              </div>
              <div style={{ fontSize: 10, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[it.manufacturer, it.description].filter(Boolean).join(' · ')}</div>
              {!!it.reasons.length && <div style={{ fontSize: 9.5, color: '#15803d', marginTop: 2 }}>✓ {it.reasons.map((r) => tr(r)).join(' · ')}</div>}
            </div>
            {it.price != null && <div style={{ fontSize: 11.5, fontWeight: 700, color: '#059669' }}>{it.currency === 'USD' ? '$' : currencySym()}{it.price.toFixed(3)}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {/* 采用型号：把 BOM 行对应器件的型号替换为该候选（用户确认动作） */}
              <button onClick={() => { adoptMpn(fuzzy.line, it); setFuzzy(null); }}
                style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: '#1f5c3b', color: '#fff', fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>{tr('采用型号')}</button>
              {it.price != null && (
                <button onClick={() => { setManualPrices((prev) => ({ ...prev, [fuzzy.line.mpn]: it.price as number })); setFuzzy(null); }}
                  style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>{tr('仅用价格')}</button>
              )}
            </div>
          </div>
        ))}
        {/* 网络参考价：非分销商实时报价，AI 依公开行情估算 */}
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed #e2e8f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>{tr('网络参考价')}</span>
            <span style={{ fontSize: 9.5, color: '#94a3b8' }}>{tr('市场平均价 · AI 估算，需人工确认')}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => askMarketPrice(fuzzy.line)} disabled={market?.busy}
              style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>
              {market?.busy ? '⟳ ' + tr('查询中…') : tr('查市场价')}
            </button>
          </div>
          {market?.msg && <div style={{ fontSize: 10, color: '#92400e', marginTop: 4 }}>{tr(market.msg)}</div>}
          {market?.typical != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, padding: '7px 9px', borderRadius: 7, border: '1px solid #fde68a', background: '#fffbeb' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: '#92400e' }}>
                  {currencySym()}{market.typical.toFixed(3)}
                  {market.low != null && market.high != null && (
                    <span style={{ fontSize: 10, fontWeight: 400, marginLeft: 6 }}>({tr('区间')} {currencySym()}{market.low.toFixed(3)}–{market.high.toFixed(3)})</span>
                  )}
                </div>
                {market.basis && <div style={{ fontSize: 9.5, color: '#a16207' }}>{market.basis}</div>}
              </div>
              <button onClick={() => { setManualPrices((prev) => ({ ...prev, [fuzzy.line.mpn]: market.typical! })); setFuzzy(null); }}
                style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#b45309', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>{tr('采用')}</button>
            </div>
          )}
        </div>

        <div style={{ textAlign: 'right', marginTop: 8 }}>
          <button onClick={() => setFuzzy(null)} style={{ padding: '5px 14px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', fontSize: 11.5, cursor: 'pointer' }}>{tr('关闭')}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>🧾 {tr('BOM清单')} <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 400 }}>{tr('共')} {bom.length} {tr('项')}</span></span>
        <div style={{ display: 'flex', gap: 6 }}>
          {Object.keys(autoRes).length > 0 && (() => {
            const sm = summarizeMatches(Object.values(autoRes), Object.fromEntries(bom.map((l) => [l.reference, l.quantity])));
            return (
              <span style={{ fontSize: 10.5, color: '#475569', marginRight: 8 }}>
                {tr('精确')} {sm.exact} · {tr('近似')} {sm.candidate} · {tr('未找到')} {sm.none}
                {sm.quoted ? ` · ${tr('报价合计')} ¥${sm.totalQuoted.toFixed(2)}` : ''}
                {sm.estimated ? ` · ${tr('估算合计')} ≈¥${sm.totalEstimated.toFixed(2)}` : ''}
              </span>
            );
          })()}
          {aiGate && (
            <div style={{ width: '100%', marginBottom: 6 }}>
              <AiGateNotice reason={aiGate.reason} cost={aiGate.cost} onClose={() => setAiGate(null)} />
            </div>
          )}
          <button onClick={runAutoMatch}
            title={tr('按位号性质 + 描述/值 + 封装，先查 ezPLM 再查分销商，都没有才用 AI 估价；结果需人工确认后才写回设计')}
            style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: autoBusy ? '#b45309' : COLORS.green, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', marginRight: 6 }}>
            {autoBusy ? `⟳ ${autoBusy.done}/${autoBusy.total}（${tr('点击停止')}）` : '🔗 ' + tr('一键关联')}
          </button>
          <button onClick={exportCsv} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #c6e2d0', background: COLORS.greenBg, color: COLORS.green, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{tr('导出 CSV')}</button>
          {onToggleFullscreen && <button onClick={onToggleFullscreen} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{isFullscreen ? tr('↙ 退出全屏') : tr('⛶ 全屏')}</button>}
        </div>
      </div>
      {bom.length === 0 ? <div style={{ textAlign: 'center', padding: 30, color: '#94a3b8', fontSize: 13 }}>{tr('暂无器件')}</div> : (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead><tr style={{ background: '#f8fafc' }}>
            {['#', tr('位号'), tr('型号'), tr('厂商'), tr('封装'), tr('来源'), tr('单价'), tr('数量')].map((h) => <th key={h} style={{ textAlign: h === tr('单价') || h === tr('数量') ? 'right' : 'left', padding: '8px 10px', fontWeight: 600, color: '#64748b', fontSize: 11, borderBottom: '2px solid #e2e8f0' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {bom.map((l, i) => (
              <tr key={l.reference + i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{i + 1}</td>
                <td style={{ padding: '7px 10px', fontWeight: 600, color: COLORS.green, maxWidth: 260 }}>
                  <RefCell refs={l.reference} />
                </td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{l.mpn}</td>
                <td style={{ padding: '7px 10px', color: '#64748b' }}>{l.manufacturer}</td>
                <td style={{ padding: '7px 10px', color: '#64748b' }}>{l.footprint}</td>
                <td style={{ padding: '7px 10px' }}>
                  {manOf(l.mpn) != null
                    ? <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#ccfbf1', color: '#0f766e', fontWeight: 700 }}>{tr('录入')}</span>
                    : dkOf(l.mpn) || netOf(l.mpn)
                    ? <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#e0f2fe', color: '#0369a1', fontWeight: 700 }}>{tr('网络价格')}{dkOf(l.mpn) ? '·DK' : '·' + netOf(l.mpn)!.vendor.slice(0, 4)}</span>
                    : srcOf(l.reference) === 'EZPLM'
                    ? <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#f1f5f9', color: '#64748b', fontWeight: 700 }}>ezPLM</span>
                    : (() => {
                      // 批量关联结果优先展示（它已经把 ezPLM/分销商/AI 估价都跑过一遍）
                      const am = autoRes[l.reference];
                      if (am) {
                        const tone = am.level === 'EXACT' ? { bg: '#dcfce7', fg: '#166534', label: '精确匹配' }
                          : am.level === 'CANDIDATE' ? { bg: '#fef3c7', fg: '#92400e', label: '近似待确认' }
                          : { bg: '#f1f5f9', fg: '#64748b', label: '未找到' };
                        return (
                          <span title={am.detail + (am.best ? ` → ${am.best.mpn}` : '')}
                            onClick={() => am.best && openFuzzy(l)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: am.best ? 'pointer' : 'default' }}>
                            <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, fontWeight: 700, background: tone.bg, color: tone.fg }}>{tr(tone.label)}</span>
                            {am.best && <span style={{ fontSize: 9.5, fontFamily: 'monospace', color: '#475569', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{am.best.mpn}</span>}
                            {am.price && (
                              <span style={{ fontSize: 9.5, fontWeight: 700, color: am.price.kind === 'estimate' ? '#b45309' : '#059669' }}
                                title={am.price.kind === 'estimate' ? tr('AI 估算，不是真实报价') : `${am.price.vendor ?? ''} ${tr('报价')}`}>
                                {am.price.kind === 'estimate' ? '≈' : ''}{am.price.currency === 'USD' ? '$' : '¥'}{am.price.amount.toFixed(3)}
                              </span>
                            )}
                          </span>
                        );
                      }
                      const why = whyNotPriceable(l.mpn, l.reference, l.footprint);
                      // 结构件（测试点/安装孔）确实不需要采购；其余"值不是型号 / 型号不完整"的行
                      // 照样可以按 参数 + 封装 + 类别 去 ezPLM / DigiKey / Mouser 匹配可采购料号，
                      // 因此给出「按参数选型」入口，而不是只留一句灰字。
                      const structural = why === '结构件无需采购';
                      return structural
                        ? <span style={{ fontSize: 9.5, color: '#94a3b8' }} title={CLASS_LABEL[classifyByRefDes(l.reference, l.footprint, l.mpn)]}>{tr(why)}</span>
                        : why
                        ? <span onClick={() => openFuzzy(l)} title={tr(why) + ' — ' + tr('点击按参数/封装/类别匹配可采购型号')}
                            style={{ fontSize: 9.5, color: '#0369a1', cursor: 'pointer', textDecoration: 'underline dotted' }}>{tr('按参数选型')}</span>
                        : queried[l.mpn]
                        ? <span onClick={() => openFuzzy(l)} title={tr('点击按型号/封装/值模糊查找相近器件的价格')}
                            style={{ fontSize: 9.5, color: '#0369a1', cursor: 'pointer', textDecoration: 'underline dotted' }}>{tr('查找相近')}</span>
                        : <span style={{ fontSize: 10, color: '#cbd5e1' }}>{tr('查询中…')}</span>;
                    })()}
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600 }}>
                  {editingMpn === l.mpn ? (
                    <input autoFocus type="number" step="0.01" defaultValue={manOf(l.mpn) ?? dkOf(l.mpn)?.unitPrice ?? netOf(l.mpn)?.price ?? l.unitPrice?.amount ?? ''}
                      onBlur={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v >= 0) setManualPrices((prev) => ({ ...prev, [l.mpn]: v })); setEditingMpn(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingMpn(null); }}
                      style={{ width: 70, padding: '2px 5px', borderRadius: 4, border: '1px solid #93c5fd', fontSize: 11, textAlign: 'right' }} />
                  ) : (
                    <span onClick={() => setEditingMpn(l.mpn)} title={tr('点击手工修改单价')} style={{ cursor: 'pointer' }}>
                      {manOf(l.mpn) != null
                        ? <span style={{ color: '#0f766e' }}>{currencySym()}{manOf(l.mpn)!.toFixed(2)} ✎</span>
                        : dkOf(l.mpn)
                        ? <span title={`DigiKey 实时 · 库存 ${dkOf(l.mpn)!.stock?.toLocaleString() ?? '—'}`} style={{ color: '#0369a1' }}>{currencySym()}{dkOf(l.mpn)!.unitPrice!.toFixed(2)}</span>
                        : netOf(l.mpn)
                        ? <span title={`${netOf(l.mpn)!.vendor} 实时`} style={{ color: '#7c3aed' }}>{currencySym()}{netOf(l.mpn)!.price.toFixed(2)}</span>
                        : <span style={{ color: '#94a3b8' }} title={whyNotPriceable(l.mpn, l.reference, l.footprint) ?? tr('点击手工录入')}>—</span>}
                    </span>
                  )}
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'right' }}>{l.quantity}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr>
            {/* 只有"每行都有价格且币种唯一"才允许出现总价；
                否则报覆盖度与分项小计 —— 把缺价的行按 0 加进总价是会误导采购的 */}
            <td colSpan={8} style={{ padding: 10, borderTop: '2px solid #e2e8f0' }}>
              {(() => {
                const ps = summarizeBomPricing(bom.map((l) => {
                  const am = autoRes[l.reference];
                  const manual = manOf(l.mpn);
                  const price = manual != null ? { amount: manual, currency: 'CNY' }
                    : am?.price ? { amount: am.price.amount, currency: am.price.currency }
                    : dkOf(l.mpn)?.unitPrice != null ? { amount: dkOf(l.mpn)!.unitPrice!, currency: dkOf(l.mpn)!.currency ?? 'CNY' }
                    : l.unitPrice ? { amount: l.unitPrice.amount, currency: l.unitPrice.currency } : undefined;
                  return { price, kind: am?.price?.kind ?? 'quote' as const, quantity: l.quantity };
                }));
                const money = (by: Record<string, number>) => Object.entries(by)
                  .map(([cur, v]) => fmtMoney(v, cur === 'UNKNOWN' ? undefined : cur)).join(' + ') || '—';
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', justifyContent: 'flex-end', fontSize: 12 }}>
                    <span style={{ color: '#64748b' }}>
                      {tr('报价覆盖')} <b style={{ color: ps.unknownLines ? '#b45309' : '#15803d' }}>{ps.quotedLines + ps.estimatedLines} / {ps.totalLines}</b>
                      {ps.unknownLines ? ` · ${ps.unknownLines} ${tr('行无价格')}` : ''}
                    </span>
                    <span style={{ color: '#059669' }}>{tr('已报价小计')} <b>{money(ps.quotedByCurrency)}</b></span>
                    {ps.estimatedLines > 0 && <span style={{ color: '#b45309' }}>{tr('估算小计')} <b>≈{money(ps.estimatedByCurrency)}</b></span>}
                    {ps.canShowTotal
                      ? <span style={{ fontWeight: 700, color: '#dc2626', fontSize: 14 }}>{tr('BOM 总价')} {fmtMoney(ps.total, ps.currency)}</span>
                      : <span style={{ fontSize: 10.5, color: '#94a3b8' }}>
                          {ps.complete ? tr('币种不统一，不汇总总价') : tr('仍有行未取到价格，不显示总价')}
                        </span>}
                  </div>
                );
              })()}
            </td>
          </tr></tfoot>
        </table>
      )}
      {fuzzyModal}
    </div>
  );
}

/** 位号单元格：自然排序，超过 8 个折叠为「前8 +N」，点击展开/悬停查看全部 */
function RefCell({ refs }: { refs: string }) {
  const [open, setOpen] = useState(false);
  const list = refs.split(',').map((r) => r.trim()).filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (list.length <= 8 || open) {
    return <span style={{ wordBreak: 'break-all', fontSize: list.length > 8 ? 10.5 : undefined, cursor: list.length > 8 ? 'pointer' : undefined }}
      onClick={() => list.length > 8 && setOpen(false)} title={list.join(', ')}>{list.join(', ')}</span>;
  }
  return (
    <span style={{ cursor: 'pointer' }} title={list.join(', ')} onClick={() => setOpen(true)}>
      {list.slice(0, 8).join(', ')}
      <span style={{ marginLeft: 4, padding: '1px 6px', borderRadius: 8, background: '#ecfdf5', color: '#059669', fontSize: 10, fontWeight: 700 }}>+{list.length - 8}</span>
    </span>
  );
}

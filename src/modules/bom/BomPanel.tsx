/**
 * modules/bom/BomPanel.tsx
 * BOM 清单 —— 从 store 的 doc.bom 渲染，支持 CSV 导出。
 */
import { tr } from '../../shared/i18n';
import { useDesignStore } from '../../state/designStore';
import { bomTotal } from '../../design-core/document/services';
import { fmtMoney, COLORS } from '../../shared/theme';
import { useEffect, useState } from 'react';
import type { BomLine } from '../../design-core/document/types';
import { geminiComplete, extractJson } from '../../providers/gemini';
import { isPriceable, whyNotPriceable, classifyByRefDes, pricingPriority, CLASS_LABEL } from './part-class';
import { fetchDigikeyOffer, type DigikeyOffer } from '../../providers/digikey';
import { fetchSupplierOffers } from '../../providers/suppliers';

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
  const [fuzzy, setFuzzy] = useState<{ line: BomLine; busy: boolean; items: { vendor: string; mpn: string; manufacturer: string; description?: string; price: number; currency?: string; stock?: number; url?: string }[]; msg?: string } | null>(null);
  const openFuzzy = async (l: BomLine) => {
    setMarket(null);
    setFuzzy({ line: l, busy: true, items: [] });
    try {
      const qs = new URLSearchParams({ path: 'fuzzy', mpn: l.mpn ?? '', footprint: l.footprint ?? '', desc: l.description ?? '' });
      const r = await fetch(`/api/suppliers?${qs}`);
      const j = await r.json();
      setFuzzy({ line: l, busy: false, items: Array.isArray(j.items) ? j.items : [], msg: j.message });
    } catch (e) {
      setFuzzy({ line: l, busy: false, items: [], msg: (e as Error).message });
    }
  };

  /** 网络参考价：AI 按公开市场行情给区间。明确标注为估算，必须人工确认后才落为录入价。 */
  const askMarketPrice = async (l: BomLine) => {
    setMarket({ busy: true });
    try {
      const desc = [l.mpn, l.footprint, l.description].filter(Boolean).join(' / ');
      const raw = await geminiComplete(
        `器件：${desc}（位号 ${l.reference}）。\n` +
        `请给出该类器件当前的**市场平均单价**参考（小批量 100 片价，人民币）。\n` +
        `只回答价格信息，不要其它内容。若无法判断请把 confident 设为 false。\n` +
        `严格输出 JSON：{"low":数字,"high":数字,"typical":数字,"basis":"依据一句话","confident":true|false}`,
      );
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
  const [editingMpn, setEditingMpn] = useState<string | null>(null);
  const manOf = (mpn: string): number | undefined => manualPrices[mpn];
  const total = bom.reduce((sum, l) => sum + (manOf(l.mpn) ?? dkOf(l.mpn)?.unitPrice ?? netOf(l.mpn)?.price ?? l.unitPrice?.amount ?? 0) * l.quantity, 0);

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
      manOf(l.mpn) != null ? '录入' : dkOf(l.mpn) ? '网络价格(DigiKey)' : netOf(l.mpn) ? `网络价格(${netOf(l.mpn)!.vendor})` : '',
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
          <span style={{ marginLeft: 6, color: '#b45309' }}>{tr('模糊匹配结果需人工确认后作为录入价')}</span>
        </div>
        {fuzzy.busy && <div style={{ fontSize: 11.5, color: '#64748b' }}>{tr('检索中…')}</div>}
        {!fuzzy.busy && !fuzzy.items.length && <div style={{ fontSize: 11.5, color: '#92400e' }}>{fuzzy.msg ?? tr('未找到相近器件')}</div>}
        {fuzzy.items.map((it, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', marginBottom: 5, borderRadius: 7, border: '1px solid #e2e8f0' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'monospace', fontSize: 11.5, fontWeight: 700 }}>{it.mpn}</div>
              <div style={{ fontSize: 10, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.manufacturer} · {it.description}</div>
            </div>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: '#059669' }}>{it.currency === 'USD' ? '$' : '¥'}{it.price.toFixed(3)}</div>
            <button onClick={() => { setManualPrices((prev) => ({ ...prev, [fuzzy.line.mpn]: it.price })); setFuzzy(null); }}
              style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#1f5c3b', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>{tr('采用')}</button>
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
          {market?.msg && <div style={{ fontSize: 10, color: '#92400e', marginTop: 4 }}>{market.msg}</div>}
          {market?.typical != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, padding: '7px 9px', borderRadius: 7, border: '1px solid #fde68a', background: '#fffbeb' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: '#92400e' }}>
                  ¥{market.typical.toFixed(3)}
                  {market.low != null && market.high != null && (
                    <span style={{ fontSize: 10, fontWeight: 400, marginLeft: 6 }}>({tr('区间')} ¥{market.low.toFixed(3)}–{market.high.toFixed(3)})</span>
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
          <button onClick={exportCsv} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #c6e2d0', background: COLORS.greenBg, color: COLORS.green, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{tr('导出 CSV')}</button>
          {onToggleFullscreen && <button onClick={onToggleFullscreen} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{isFullscreen ? '↙ 退出全屏' : '⛶ 全屏'}</button>}
        </div>
      </div>
      {bom.length === 0 ? <div style={{ textAlign: 'center', padding: 30, color: '#94a3b8', fontSize: 13 }}>暂无器件</div> : (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead><tr style={{ background: '#f8fafc' }}>
            {['#', '位号', '型号', '厂商', '封装', '来源', '单价', '数量'].map((h) => <th key={h} style={{ textAlign: h === '单价' || h === '数量' ? 'right' : 'left', padding: '8px 10px', fontWeight: 600, color: '#64748b', fontSize: 11, borderBottom: '2px solid #e2e8f0' }}>{h}</th>)}
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
                      const why = whyNotPriceable(l.mpn, l.reference, l.footprint);
                      return why
                        ? <span style={{ fontSize: 9.5, color: '#94a3b8' }} title={CLASS_LABEL[classifyByRefDes(l.reference, l.footprint, l.mpn)]}>{tr(why)}</span>
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
                        ? <span style={{ color: '#0f766e' }}>¥{manOf(l.mpn)!.toFixed(2)} ✎</span>
                        : dkOf(l.mpn)
                        ? <span title={`DigiKey 实时 · 库存 ${dkOf(l.mpn)!.stock?.toLocaleString() ?? '—'}`} style={{ color: '#0369a1' }}>¥{dkOf(l.mpn)!.unitPrice!.toFixed(2)}</span>
                        : netOf(l.mpn)
                        ? <span title={`${netOf(l.mpn)!.vendor} 实时`} style={{ color: '#7c3aed' }}>{netOf(l.mpn)!.currency === 'USD' ? '$' : '¥'}{netOf(l.mpn)!.price.toFixed(2)}</span>
                        : <span style={{ color: '#94a3b8' }} title={whyNotPriceable(l.mpn, l.reference, l.footprint) ?? tr('点击手工录入')}>—</span>}
                    </span>
                  )}
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'right' }}>{l.quantity}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr>
            <td colSpan={6} style={{ padding: 10, textAlign: 'right', fontWeight: 700, borderTop: '2px solid #e2e8f0' }}>{tr('BOM 总价（录入 > 网络实时价 > 估价）')}</td>
            <td style={{ padding: 10, textAlign: 'right', fontWeight: 700, color: '#dc2626', fontSize: 14, borderTop: '2px solid #e2e8f0' }}>{fmtMoney(total)}</td>
            <td style={{ borderTop: '2px solid #e2e8f0' }} />
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

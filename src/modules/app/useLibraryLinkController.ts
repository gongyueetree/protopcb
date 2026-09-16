/**
 * modules/app/useLibraryLinkController.ts — 方案器件与 ezPLM 库的关联推荐（从 App.tsx 抽出）。
 * 逐级截短型号做宽召回，统一过 lookup 门禁（filterAndRank）；无合格候选如实告知。
 */
import { useCallback, useRef, useState } from 'react';
import { searchEzplmParts } from '../../application/parts';
import { filterAndRank } from '../../design-core/part-match-policy';

export function useLibraryLinkController() {
  const [linkRow, setLinkRow] = useState<string | null>(null);
  const [linkKw, setLinkKw] = useState('');
  const [linkResults, setLinkResults] = useState<Awaited<ReturnType<typeof searchEzplmParts>>['items']>([]);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkIsRec, setLinkIsRec] = useState(false); // 当前结果是否为自动推荐

  /** 智能推荐：AI 型号逐级截短检索（GD32F103C8T6 → GD32F103C8 → GD32F103 → GD32），
   *  再叠加封装关键词，并集去重取前 6 —— "不能精准匹配"的也给出近似候选 */
  /**
   * 关联推荐：逐级截短型号做**宽召回**，但召回结果不能直接当候选。
   * 此前把 API 返回顺序原样展示，截到 4 个字符时会捞回一堆同前缀但毫不相干的料。
   * 现在所有召回统一过 lookup 门禁（filterAndRank）：
   * 只有 EXACT/FAMILY 进正式候选，FUZZY 明确标注为相近，REJECTED 直接丢弃；
   * 一个合格候选都没有时如实说"没有合格候选"，不为了凑数展示垃圾。
   */
  const autoRecommend = async (mpn: string, footprint?: string) => {
    setLinkBusy(true); setLinkIsRec(true);
    const seen = new Set<string>();
    const pool: typeof linkResults = [];
    const tryKw = async (kw: string) => {
      if (!kw || kw.length < 3 || pool.length >= 40) return;
      const r = await searchEzplmParts(kw, 10).catch(() => ({ available: false, items: [] as typeof linkResults }));
      for (const it of r.items) {
        if (seen.has(it.componentId)) continue;
        seen.add(it.componentId); pool.push(it);
      }
    };
    const stem = mpn.replace(/[^A-Za-z0-9]/g, '');
    const cuts = [mpn, stem, stem.slice(0, 10), stem.slice(0, 8), stem.slice(0, 6), stem.slice(0, 4)];
    for (const c of [...new Set(cuts)]) { await tryKw(c); }
    if (footprint) await tryKw(footprint.split('_')[0].split('-')[0]);

    const graded = filterAndRank(mpn, pool.map((x) => ({
      mpn: x.mpn, description: x.description, category: x.category,
      footprint: x.defaultFootprintName, pins: x.pins, __src: x,
    })), 'lookup', { footprint });
    const pick = (g: typeof graded.accepted) => g.slice(0, 6).map((x) => (x.item as unknown as { __src: typeof linkResults[number] }).__src);
    const qualified = [...pick(graded.accepted), ...pick(graded.nearby).slice(0, Math.max(0, 6 - graded.accepted.length))];
    setLinkResults(qualified);
    setLinkNoMatch(qualified.length === 0 && pool.length > 0);
    setLinkBusy(false);
  };
  /** 召回有结果但全部不合格：如实告知，而不是显示一堆不相干的料 */
  const [linkNoMatch, setLinkNoMatch] = useState(false);
  const linkSeq = useRef(0);
  /** 关联搜索（防抖 250ms + 序号守卫，避免旧响应覆盖新结果） */
  const searchLink = useCallback((kw: string) => {
    const q = kw.trim();
    const seq = ++linkSeq.current;
    if (!q) { setLinkResults([]); setLinkBusy(false); return; }
    setLinkBusy(true);
    setTimeout(async () => {
      if (seq !== linkSeq.current) return;
      const r = await searchEzplmParts(q, 6).catch(() => ({ items: [] as typeof linkResults }));
      if (seq !== linkSeq.current) return;
      setLinkResults(r.items);
      setLinkBusy(false);
    }, 250);
  }, []);

  return {
    linkRow, setLinkRow, linkKw, setLinkKw, linkResults, setLinkResults, linkBusy, setLinkBusy,
    linkIsRec, setLinkIsRec, linkNoMatch, setLinkNoMatch, autoRecommend, searchLink,
  };
}

/**
 * modules/design-review/ReviewPanel.tsx
 * 设计审查页 —— 汇总**确定性**检查结果：
 *   已有 reviewResults + 自动放置违规 + 外壳干涉 + 器件数据可信度。
 *
 * 关于评分（重要）：这里的分数不是"设计质量印象分"，而是
 *   通过项 / 可判定的检查项总数
 * 每一项都列出来可以逐条复核。任何无法由几何或数据库事实判定的内容
 * （电路是否正确工作、性能是否达标）不进入评分，也不在本页给结论。
 */
import { useMemo } from 'react';
import { useDesignStore } from '../../state/designStore';
import { tr } from '../../shared/i18n';
import { COLORS } from '../../shared/theme';
import { DEFAULT_ENCLOSURE, checkEnclosure } from '../../design-core/enclosure';
import { findOverlaps } from '../../design-core/collision';
import { summarizeTrust } from '../../design-core/trust';

interface CheckItem {
  id: string;
  group: string;
  label: string;
  pass: boolean;
  detail: string;
  /** true = 仅提示，不计入评分 */
  advisory?: boolean;
}

export function ReviewPanel() {
  const doc = useDesignStore((s) => s.doc);
  const placementViolations = useDesignStore((s) => s.placementViolations);

  const items = useMemo<CheckItem[]>(() => {
    const out: CheckItem[] = [];
    const comps = doc.components;

    // —— 布局（几何，可完全判定）——
    const overlaps = findOverlaps(comps);
    out.push({
      id: 'overlap', group: tr('布局'), label: tr('器件无重叠'),
      pass: overlaps.size === 0,
      detail: overlaps.size ? `${overlaps.size} ${tr('个器件间距不足或重叠')}` : tr('全部器件满足最小间距'),
    });
    const vio = Object.keys(placementViolations).length;
    out.push({
      id: 'placement', group: tr('布局'), label: tr('自动放置无违规'),
      pass: vio === 0,
      detail: vio ? `${vio} ${tr('个器件未找到合法位置（见画布提示）')}` : tr('自动放置结果全部合法'),
    });
    const offBoard = comps.filter((c) => c.placement.xMm < 0 || c.placement.yMm < 0 || c.placement.xMm > doc.board.widthMm || c.placement.yMm > doc.board.heightMm);
    out.push({
      id: 'onboard', group: tr('布局'), label: tr('器件中心均在板内'),
      pass: offBoard.length === 0,
      detail: offBoard.length ? offBoard.map((c) => c.reference).join('、') : tr('无器件中心落在板外'),
    });

    // —— 数据完整性（数据库事实）——
    const noFp = comps.filter((c) => !c.footprint?.name);
    out.push({
      id: 'footprint', group: tr('数据完整性'), label: tr('全部器件有封装'),
      pass: noFp.length === 0,
      detail: noFp.length ? noFp.map((c) => c.reference).join('、') : tr('每个器件都已绑定封装'),
    });
    // 唯一口径：不再自己过滤 —— 此前这里 PLACEHOLDER=0 就写"全部型号已在器件库精确匹配"，
    // 哪怕还有 24 个 CANDIDATE，与同页的可信度分布自相矛盾
    const trust = summarizeTrust(comps);
    out.push({
      id: 'trust', group: tr('数据完整性'), label: tr('型号已核对'),
      pass: trust.engineeringReady,
      detail: trust.total
        ? `${tr('已验证')} ${trust.verified} · ${tr('待人工确认')} ${trust.candidate} · ${tr('未验证')} ${trust.placeholder}`
        : tr('无器件'),
    });

    // —— 结构（几何）——
    const encSpec = { ...DEFAULT_ENCLOSURE, ...(doc.enclosure ?? {}) };
    if (encSpec.enabled) {
      const encIssues = checkEnclosure(doc, encSpec);
      const errs = encIssues.filter((i) => i.level === 'error');
      out.push({
        id: 'enclosure', group: tr('结构'), label: tr('PCB 与外壳无干涉'),
        pass: errs.length === 0,
        detail: errs.length ? errs[0].message : tr('当前外壳参数下无几何冲突'),
      });
      for (const w of encIssues.filter((i) => i.level !== 'error')) {
        out.push({ id: 'enc-' + w.code, group: tr('结构'), label: tr('结构提示'), pass: true, advisory: true, detail: w.message });
      }
    }

    // —— 电气（仅在有真实 netlist 时判定）——
    const netCount = Object.keys(doc.nets ?? {}).filter((k) => k !== '0').length;
    if (netCount) {
      const unconnected = comps.filter((c) => !Object.values(c.display?.padNets ?? {}).some((n) => n > 0));
      out.push({
        id: 'connected', group: tr('电气'), label: tr('器件均有网络连接'),
        pass: unconnected.length === 0,
        detail: unconnected.length ? unconnected.map((c) => c.reference).join('、') : `${netCount} ${tr('个网络，全部器件均已连接')}`,
      });
    } else {
      out.push({
        id: 'nonet', group: tr('电气'), label: tr('电气连接检查'), pass: true, advisory: true,
        detail: tr('当前设计没有 netlist（未导入 KiCad 工程），无法进行电气连接检查 —— 本页不对电路正确性下任何结论。'),
      });
    }
    return out;
  }, [doc, placementViolations]);

  const scored = items.filter((i) => !i.advisory);
  const passed = scored.filter((i) => i.pass).length;
  const pct = scored.length ? Math.round((passed / scored.length) * 100) : 0;
  const groups = [...new Set(items.map((i) => i.group))];

  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%', background: '#f8fafc' }}>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #E8F3EE', padding: 16, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 18 }}>
        <div style={{ textAlign: 'center', minWidth: 108 }}>
          <div style={{ fontSize: 34, fontWeight: 800, color: pct === 100 ? '#15803d' : pct >= 70 ? '#a16207' : '#b91c1c', lineHeight: 1 }}>{passed}<span style={{ fontSize: 17, color: '#94a3b8' }}> / {scored.length}</span></div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{tr('确定性检查通过')}</div>
        </div>
        <div style={{ flex: 1, fontSize: 11.5, color: '#475569', lineHeight: 1.7 }}>
          {tr('这里只统计可由几何或器件库事实判定的检查项，每项都可逐条复核。')}<br />
          <span style={{ color: '#94a3b8' }}>
            {tr('电路功能是否正确、性能是否达标、EMC 与热设计是否合格，本工具无法判定，因此不计入也不给结论。')}
          </span>
        </div>
      </div>

      {groups.map((g) => (
        <div key={g} style={{ background: '#fff', borderRadius: 12, border: '1px solid #E8F3EE', padding: 14, marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.green, marginBottom: 8 }}>{g}</div>
          {items.filter((i) => i.group === g).map((i) => (
            <div key={i.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 0', borderTop: '1px solid #f8fafc' }}>
              <span style={{ fontSize: 13, lineHeight: 1.4 }}>{i.advisory ? 'ℹ️' : i.pass ? '✅' : '🔴'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: i.advisory ? '#475569' : i.pass ? '#15803d' : '#b91c1c' }}>
                  {i.label}{i.advisory ? <span style={{ fontWeight: 500, color: '#94a3b8' }}> · {tr('不计入评分')}</span> : null}
                </div>
                <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.6, marginTop: 2 }}>{i.detail}</div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

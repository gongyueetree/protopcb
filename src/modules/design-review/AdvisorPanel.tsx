/**
 * modules/design-review/AdvisorPanel.tsx
 * AI 顾问 —— 实时展示设计审查、子电路推荐、PCB规格。数据来自 store + ReferenceDesignProvider。
 */
import { tr, useTranslated, useLangStore } from '../../shared/i18n';
import { z } from 'zod';
import { AiAdvisorItemSchema, validateAi } from '../../providers/ai-schema';
import { useEffect, useState } from 'react';
import { useDesignStore } from '../../state/designStore';
import { getProviders } from '../../providers/factory';
import { aiAvailable as geminiAvailable } from '../../application/ai';
import { aiRequest, extractJson } from '../../providers/ai-client';
import { recommendLayers } from '../../design-core/document/services';
import { CATEGORY_DISPLAY, COLORS } from '../../shared/theme';
import type { PeripheralCircuitRecommendation } from '../../providers/types';
import type { ComponentCategory, ReviewLevel } from '../../design-core/document/types';
import { SubCircuitSection } from './SubCircuitSection';
import { useAccessContext, anonymousContext } from '../../state/useAccessContext';
import { useAiGate } from '../account/useAiGate';
import { useEntitlementStore } from '../../state/entitlementStore';
import { loginUrl } from '../../design-core/entitlements';

const providers = getProviders();
// 身份来自 providers.identity（demo 模式自然是 demo-user，集成模式是真实身份）

const LEVEL: Record<ReviewLevel, { bg: string; color: string; label: string }> = {
  high: { bg: '#fef2f2', color: '#dc2626', label: tr('高') },
  mid: { bg: '#fffbeb', color: '#b45309', label: tr('中') },
  low: { bg: '#f0fdf4', color: '#16a34a', label: tr('低') },
  info: { bg: '#f1f5f9', color: '#64748b', label: 'ℹ' },
};


/** 基于画布器件的规则引擎建议（无 Gemini 时的动态兜底，逐条对应画布实际构成） */
function ruleSuggestions(comps: { mpn: string; category: string; family?: string }[]): { name: string; reason: string; addId?: string }[] {
  const out: { name: string; reason: string; addId?: string }[] = [];
  const has = (pred: (c: typeof comps[0]) => boolean) => comps.some(pred);
  const fam = (f: string) => has((c) => (c.family ?? '').includes(f));
  const icCount = comps.filter((c) => c.category === 'mcu' || c.category === 'ic').length;
  const capCount = comps.filter((c) => c.mpn.toUpperCase().includes('CL10') || (c.family ?? '').includes('MLCC')).length;

  if (icCount > 0 && !has((c) => c.category === 'power')) out.push({ name: tr('3.3V 稳压电路（LDO/DCDC）'), reason: tr('画布上有 IC 但没有电源管理器件，系统无法供电'), addId: 'lm1117' });
  if (fam('STM32') || fam('GD32')) {
    out.push({ name: tr('外部晶振（如 8MHz）+ 负载电容'), reason: tr('请确认时钟需求：若需 USB/精确定时等 HSI 精度不够的场景，则加外部晶振（容值按晶振 CL 与走线电容计算）；仅用内部 HSI 可省') });
    out.push({ name: tr('复位电路（10KΩ 上拉 + 100nF）'), reason: tr('NRST 引脚复位可靠性'), addId: 'res10k' });
    out.push({ name: tr('SWD 调试接口（2×5 排针）'), reason: tr('烧录与在线调试必需'), addId: 'header2x5' });
    out.push({ name: tr('BOOT0 下拉 10KΩ'), reason: tr('确保从主 Flash 启动'), addId: 'res10k' });
  }
  if (fam('ESP32')) {
    out.push({ name: tr('3.3V ≥500mA 供电'), reason: tr('ESP32 Wi-Fi 发射瞬时电流大，LDO 需选大电流型号') });
    out.push({ name: tr('天线净空区'), reason: tr('模组天线下方及周边禁止铺铜走线') });
    out.push({ name: tr('EN 引脚 RC 延时（10K+1μF）'), reason: tr('保证上电时序') });
  }
  if (fam('USB')) {
    out.push({ name: tr('USB ESD 保护（TVS 阵列）'), reason: tr('USB 接口静电防护') });
    out.push({ name: tr('CC1/CC2 各 5.1KΩ 下拉（Rd）'), reason: tr('请确认 USB 角色：若本板为 device/UFP（从机取电），则 CC1/CC2 各接 5.1K Rd；若为 host/DFP 则应为 Rp 上拉，双角色需 CC 控制器'), addId: 'res10k' });
  }
  if (fam('USB-UART') || has((c) => c.mpn.startsWith('CH340'))) out.push({ name: tr('12MHz 晶振'), reason: tr('CH340G 需外部晶振（CH340C 内置可省）') });
  if (fam('Flash')) out.push({ name: tr('CS 上拉 10KΩ'), reason: tr('SPI Flash 片选默认无效电平'), addId: 'res10k' });
  if (fam('CAN')) out.push({ name: tr('120Ω 终端电阻（按拓扑）'), reason: tr('请确认本节点位置：仅当位于 CAN 总线两个物理末端时才接 120Ω 终端；中间节点不接，否则总线阻抗失配') });
  if (icCount > capCount) out.push({ name: `去耦电容 100nF ×${icCount - capCount}`, reason: `每个 IC 电源脚就近去耦（当前 ${icCount} 个 IC / ${capCount} 个电容）`, addId: 'cap100nf' });
  if (icCount > 0 && !has((c) => c.category === 'connector')) out.push({ name: tr('供电/调试接口'), reason: tr('板卡缺少对外接口'), addId: 'usbc' });
  return out;
}


/** 设计指纹 → Gemini 结果。模块级缓存：切换面板/重渲染不会重复消耗配额 */
const geminiCache = new Map<string, { name: string; reason: string }[]>();

export function AdvisorPanel() {
  const ctx = useAccessContext() ?? anonymousContext();
  const { guard, gateNotice } = useAiGate();
  /**
   * 未登录时整页收起：这一页的每个区块（配套电路推荐、板级系统补全、
   * 按类别建议）都依赖 AI 或需要账户边界。逐块显示"需要登录"会让页面
   * 变成三段重复的挡板 —— 不如一次说清，把位置让给一句有用的说明。
   */
  const aiAllowed = useEntitlementStore((st) => st.check('advisor.analyze').allowed);
  const lang = useLangStore((st) => st.lang) === 'en' ? 'en' as const : 'zh' as const;
  const doc = useDesignStore((s) => s.doc);
  const addComponent = useDesignStore((s) => s.addComponent);
  const [subs, setSubs] = useState<Record<string, PeripheralCircuitRecommendation[]>>({});
  const [sysSugs, setSysSugs] = useState<{ name: string; reason: string; addId?: string }[]>([]);
  const [sysSource, setSysSource] = useState<'gemini' | 'gemini-cache' | 'rules' | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const coreList = doc.components.filter((c) => c.category !== 'passive').map((c) => ({ mpn: c.mpn, category: c.category, family: c.display?.family }));
  const coreSig = coreList.map((c) => c.mpn).sort().join(',');

  const analyze = async () => {
    if (!doc.components.length) { setSysSugs([]); setSysSource(null); return; }
    setAnalyzing(true);
    const all = doc.components.map((c) => ({ mpn: c.mpn, category: c.category, family: c.display?.family }));
    if (await geminiAvailable()) {
      try {
        // 结构化输入 → 服务端拼 prompt；客户端不再持有任何 prompt
        const text = await guard('advisor.analyze', async () =>
          (await aiRequest('advisor.analyze', { components: all, lang: useLangStore.getState().lang })).text);
        if (text == null) { setAnalyzing(false); return; }   // 被门禁拦下：不回落规则引擎，让用户看到明确原因
        // Zod 校验：结构不符则回落规则引擎，不让模型的半成品进 UI
        const v = validateAi(z.array(AiAdvisorItemSchema).max(8), extractJson<unknown>(text), 'AI 建议');
        if (!v.ok) throw new Error(v.error);
        const list = v.data!.map((x) => ({ name: x.name, reason: x.reason ?? '' }));
        geminiCache.set(coreSig, list);   // 设计指纹缓存：相同设计不重复调用
        setSysSugs(list);
        setSysSource('gemini');
      } catch (e) {
        console.warn('[Advisor] Gemini 失败，回退规则引擎', e);
        setSysSugs(ruleSuggestions(all));
        setSysSource('rules');
      }
    } else {
      setSysSugs(ruleSuggestions(all));
      setSysSource('rules');
    }
    setAnalyzing(false);
  };

  // ── AI 调用成本控制 ──
  // 器件每变一次就调一次 Gemini 会烧掉配额，且同一设计反复问结果也一样。
  // 策略：本地规则立即出结果；Gemini 深度分析走 3 秒防抖 + 设计指纹缓存。
  useEffect(() => {
    if (!doc.components.length) { setSysSugs([]); setSysSource(null); return; }
    // 先给规则引擎的即时结果，避免面板空白
    if (!geminiCache.has(coreSig)) {
      setSysSugs(ruleSuggestions(coreList));
      setSysSource('rules');
    } else {
      setSysSugs(geminiCache.get(coreSig)!);
      setSysSource('gemini-cache');
      return;   // 同一设计已分析过，不再调用
    }
    const timer = setTimeout(() => { analyze(); }, 3000);
    return () => clearTimeout(timer);
  }, [coreSig]);

  const cats = Array.from(new Set(doc.components.map((c) => c.category)));

  useEffect(() => {
    (async () => {
      const out: Record<string, PeripheralCircuitRecommendation[]> = {};
      for (const cat of cats) out[cat] = await providers.referenceDesigns.getRecommendedPeripheralCircuits(cat as ComponentCategory, ctx);
      setSubs(out);
    })();
  }, [cats.join(',')]);

  const quickAdd = async (componentId: string) => {
    const detail = await providers.components.getComponentDetail(componentId, ctx);
    if (detail) addComponent(detail);
  };

  const layers = recommendLayers(doc);
  const highCount = doc.reviewResults.filter((r) => r.level === 'high').length;

  if (!aiAllowed) {
    return (
      <div style={{ padding: '22px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>🤖</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.green, marginBottom: 6 }}>{tr('AI 顾问需要登录')}</div>
        <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.75, marginBottom: 12 }}>
          {tr('这里会基于画布上的器件给出配套电路、参考设计与板级补全建议。登录后即可使用，新注册赠送体验 Credit。')}
        </div>
        <a href={loginUrl(lang)}
          style={{ display: 'inline-block', padding: '7px 18px', borderRadius: 8, background: COLORS.green, color: '#fff', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
          {tr('去登录')}
        </a>
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 12, lineHeight: 1.7 }}>
          {tr('未登录仍可使用：画布编辑、KiCad 工程导入、ezPLM 器件库检索、3D 与外壳、导出原型文件。')}
        </div>
      </div>
    );
  }


  return (
    <div>
      {/* 配套电路推荐：器件级（参考设计优先 → AI 兜底）在上，板级系统补全在下。
          合并的理由：两者回答的是同一个问题"还缺什么"，分成两块用户要在两处看同一件事。 */}
      <Section title={"🧩 " + tr('配套电路推荐')}>
        <SubCircuitSection />
      </Section>

      {/* 板级补全：不针对某一颗器件，而是看整块板还缺什么子系统 */}
      <Section title={"🧠 " + tr('板级系统补全')} badge={sysSugs.length || undefined}>
        {gateNotice && <div style={{ marginBottom: 6 }}>{gateNotice}</div>}
        {doc.components.length === 0 ? <Empty text={tr('添加器件后，AI 分析系统还缺什么')} /> : analyzing ? <Empty text={tr('分析中...')} /> : (
          <>
            <div style={{ fontSize: 9.5, color: '#94a3b8', marginBottom: 6 }}>{sysSource === 'gemini' ? tr('由 Gemini 基于画布器件实时生成')
              : sysSource === 'gemini-cache' ? tr('由 Gemini 生成（本会话缓存结果）')
              : tr('规则引擎基于画布器件动态生成（在 Vercel 配置 GEMINI_API_KEY 后由 Gemini 生成）')}</div>
            {sysSugs.length === 0 ? <Empty text={tr('当前构成已较完整 ✓')} /> : sysSugs.map((g, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '7px 9px', marginBottom: 5, borderRadius: 7, background: '#fff', border: '1px solid #f1f5f9' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: '#334155' }}><TrDyn text={g.name} /></div>
                  <div style={{ fontSize: 10, color: '#64748b' }}><TrDyn text={g.reason} /></div>
                </div>
                {g.addId && <button onClick={() => quickAdd(g.addId!)} style={{ flexShrink: 0, padding: '3px 9px', borderRadius: 5, border: 'none', background: COLORS.green, color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>+ {tr('添加')}</button>}
              </div>
            ))}
          </>
        )}
      </Section>

      {/* 按类别的通用配套建议：与上面的「配套电路推荐」同属一件事，
          放在同一区的下半部分，避免用户在两处看同一个问题 */}
      <Section title={"📦 " + tr('按类别的通用建议')} badge={cats.length || undefined}>
        {doc.components.length === 0 ? <Empty text={tr('添加器件后推荐配套子电路')} /> :
          cats.map((cat) => (
            <div key={cat} style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.green, marginBottom: 4 }}>{tr(CATEGORY_DISPLAY[cat as ComponentCategory].name)}</div>
              {(subs[cat] ?? []).map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '5px 8px', marginBottom: 3, borderRadius: 6, background: '#f8fafc' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: '#334155' }}><TrDyn text={r.name} /></div>
                    <div style={{ fontSize: 9.5, color: '#64748b' }}><TrDyn text={r.parts} /></div>
                  </div>
                  {r.quickAddComponentId && <button onClick={() => quickAdd(r.quickAddComponentId!)} style={miniBtn}>+ {tr('上板')}</button>}
                </div>
              ))}
            </div>
          ))}
      </Section>

      {/* PCB规格 */}
      <Section title={"📋 " + tr('PCB设计规格')}>
        <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse', marginTop: 6 }}>
          <tbody>
            {[
              [tr('层数'), `${layers}` + tr('层'), layers === 4 ? tr('密度高,建议4层') : tr('2层可满足')],
              [tr('板厚'), '1.6mm', tr('标准')],
              [tr('铜厚'), '1oz', tr('大电流局部2oz')],
              [tr('线宽/距'), '6/6mil', tr('标准工艺')],
              [tr('板框'), `${doc.board.widthMm}×${doc.board.heightMm}mm`, doc.board.shape === 'lshape' ? tr('异形(费用+)') : tr('常规')],
            ].map(([k, v, n]) => (
              <tr key={k} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '4px 6px', color: '#94a3b8' }}>{k}</td>
                <td style={{ padding: '4px 6px', fontWeight: 700, color: COLORS.green }}>{v}</td>
                <td style={{ padding: '4px 6px', color: '#64748b' }}>{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 9.5, color: '#64748b', marginTop: 6, lineHeight: 1.6 }}>
          <b>{tr('布局要点')}</b>：{tr('晶振贴MCU包地 · 去耦电容贴引脚 · USB差分等长(90Ω) · 电源回路最小化 · 连接器靠板边')}
        </div>
      </Section>

      {/* 风险 */}
      <Section title={"⚠️ " + tr('设计风险')} badge={highCount ? `${highCount}` + tr('高') : undefined} badgeColor="#dc2626">
        {doc.reviewResults.map((r) => {
          const st = LEVEL[r.level];
          return (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: st.bg }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: st.color, width: 14, textAlign: 'center' }}>{st.label}</span>
              <span style={{ fontSize: 10.5, color: '#334155' }}><TrDyn text={r.title + (r.detail ? ` — ${r.detail}` : '')} /></span>
            </div>
          );
        })}
      </Section>
    </div>
  );
}

function Section({ title, badge, badgeColor, children }: { title: string; badge?: string | number; badgeColor?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 8, borderRadius: 10, border: '1px solid #e2e8f0', background: '#fff', overflow: 'hidden' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', cursor: 'pointer', background: open ? '#f7fcf9' : '#fff' }}>
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: '#1e293b' }}>{title}</span>
        {badge != null && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 8, background: badgeColor ?? COLORS.green, color: '#fff', fontWeight: 700 }}>{badge}</span>}
        <span style={{ fontSize: 9, color: '#94a3b8' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && <div style={{ padding: '4px 12px 12px', borderTop: '1px solid #f1f5f9' }}>{children}</div>}
    </div>
  );
}
const Empty = ({ text }: { text: string }) => <div style={{ fontSize: 11, color: '#94a3b8', paddingTop: 6 }}>{text}</div>;
const miniBtn: React.CSSProperties = { fontSize: 9, padding: '2px 7px', borderRadius: 4, border: '1px solid #c6e2d0', background: '#fff', color: COLORS.green, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' };

/** 动态内容（规则条目/中文数据）：英文模式经 Gemini 翻译并缓存 */
function TrDyn({ text }: { text: string }) {
  const t = useTranslated(text);
  return <>{t}</>;
}

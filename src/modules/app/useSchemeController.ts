/**
 * modules/app/useSchemeController.ts — AI 方案生成 / 多轮修改 / 确认上画布（从 App.tsx 抽出）。
 * 依赖：ProviderRegistry 的 ai、entitlement 门禁、dialog 服务；不持有布局状态。
 */
import { useEffect, useState } from 'react';
import { getProviders } from '../../providers/factory';
import { useDesignStore } from '../../state/designStore';
import { useEntitlementStore } from '../../state/entitlementStore';
import { useAccessContext, anonymousContext } from '../../state/useAccessContext';
import { dialogs } from '../ui/dialogStore';
import { tr } from '../../shared/i18n';
import { diffSchemes } from '../../design-core/scheme-workspace';
import type { SchemeProposal } from '../scheme/SchemeWorkspace';
import { autoKicadFootprint } from '../../design-core/geometry/auto-kicad-footprint';
import type { DenyReason } from '../../design-core/entitlements';

const providers = getProviders();

export function useSchemeController(aiPrompt: string) {
  const ctx = useAccessContext() ?? anonymousContext();
  const [aiBusy, setAiBusy] = useState(false);
  const [aiGate, setAiGate] = useState<{ reason: DenyReason; cost?: number } | null>(null);
  const checkCap = useEntitlementStore((s) => s.check);
  const [aiProposal, setAiProposal] = useState<SchemeProposal | null>(null);
  const [coreOnly, setCoreOnly] = useState(false);
  useEffect(() => { if (aiProposal) setCoreOnly(false); }, [aiProposal != null]); // eslint-disable-line react-hooks/exhaustive-deps
  const genScheme = async () => {
    if (!aiPrompt.trim()) return;
    // 前端门禁只为体验（少一次白跑的请求）；真正的拦截在服务端
    const gate = checkCap('scheme.generate');
    if (!gate.allowed) { setAiGate({ reason: gate.reason!, cost: gate.cost }); return; }
    setAiBusy(true);
    try {
      const result = await providers.ai.generateScheme({ prompt: aiPrompt }, ctx);
      // Gemini 真实链路：直接携带完整器件（已完成 ezPLM 云端映射 / 封装占位）
      if (result.items?.length) {
        setAiProposal({
          rationale: result.rationale, source: result.source, fallbackReason: result.fallbackReason,
          details: result.items as unknown as SchemeProposal['details'],
          blocks: result.blocks, blockLinks: result.blockLinks, round: 1,
        });
        setAiBusy(false);
        return;
      }
      // Mock 链路：componentIds → 目录映射
      const mapped = await Promise.all(result.componentIds.map(async (id) => {
        const d = await providers.components.getComponentDetail(id, ctx);
        if (d) return { ...d, mapSource: d.org ? tr('本组织') : tr('ezPLM云端') };
        // 未命中：按 id 猜封装做占位（真实链路中由 LLM 返回封装建议）
        return {
          componentId: `fp_${id}_${Date.now()}`, mpn: id, manufacturer: '—',
          category: 'passive' as const, defaultFootprintName: '0402', family: 'Footprint',
          description: `未映射到 ezPLM 器件，以封装占位`, pins: 2, mapSource: tr('封装占位'),
        };
      }));
      setAiProposal({ rationale: result.rationale, source: result.source, fallbackReason: result.fallbackReason, details: mapped });
    } catch (err) {
      dialogs.toast(tr('生成失败：') + (err as Error).message, 'error');
    }
    setAiBusy(false);
  };

  /**
   * 多轮修改：把上一版方案 + 用户意见交给模型重算，
   * 然后用确定性 diff 得出"本轮实际变更"（不采信模型自述）。
   */
  const reviseScheme = async (feedback: string) => {
    if (!aiProposal) return;
    setAiBusy(true);
    const prevDetails = aiProposal.details;
    try {
      const result = await providers.ai.generateScheme({
        prompt: aiPrompt,
        previous: {
          summary: aiProposal.rationale,
          components: prevDetails.map((d) => ({ mpn: d.mpn, group: d.group, core: d.core, reason: d.description })),
        },
        feedback,
      }, ctx);
      if (!result.items?.length) throw new Error(tr('模型未返回器件清单'));
      const details = result.items as unknown as SchemeProposal['details'];
      setAiProposal({
        rationale: result.rationale, source: result.source, fallbackReason: result.fallbackReason,
        details, blocks: result.blocks, blockLinks: result.blockLinks,
        changes: diffSchemes(prevDetails, details),
        round: (aiProposal.round ?? 1) + 1,
      });
    } catch (err) {
      dialogs.toast(tr('重新生成失败：') + (err as Error).message, 'error');
    }
    setAiBusy(false);
  };

  const confirmScheme = (picked?: SchemeProposal['details']) => {
    if (!aiProposal) return;
    const details = picked ?? (coreOnly ? aiProposal.details.filter((x) => x.category !== 'passive') : aiProposal.details);
    useDesignStore.getState().placeScheme(details as never, { requirement: aiPrompt, rationale: aiProposal.rationale });
    setAiProposal(null);
    // 无源器件/连接器：ezPLM 未收录 → 异步按封装名自动关联 KiCad 官方库（精确焊盘 + 真实 3D）
    setTimeout(() => {
      const comps = useDesignStore.getState().doc.components;
      const seen = new Set<string>();
      for (const c of comps) {
        if (!['passive', 'connector', 'electromech'].includes(c.category)) continue;
        if (c.display?.stepUrl || c.display?.footprintFileUrl) continue;
        const fp = c.footprint.name;
        if (seen.has(fp)) continue;
        seen.add(fp);
        autoKicadFootprint(fp).then((stepUrl) => { if (stepUrl) useDesignStore.getState().setStepUrlByFootprint(fp, stepUrl); }).catch(() => { /* 兜底参数化 */ });
      }
    }, 50);
  };

  return { aiProposal, setAiProposal, coreOnly, setCoreOnly, aiBusy, aiGate, setAiGate, checkCap, genScheme, reviseScheme, confirmScheme };
}

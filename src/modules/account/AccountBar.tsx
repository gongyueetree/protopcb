/**
 * modules/account/AccountBar.tsx
 * 顶栏的账户状态：未登录显示登录引导，已登录显示 Credit 余额。
 *
 * 措辞原则：未登录**不是**残缺状态。画布、导入 KiCad、器件库检索、导出原型文件
 * 都能完整使用；需要登录的只有 AI 与云端保存。提示语必须说清这一点，
 * 而不是笼统地"请登录"。
 */
import { useEffect } from 'react';
import { useEntitlementStore, loginUrl, buyCreditsUrl } from '../../state/entitlementStore';
import { useLangStore, tr } from '../../shared/i18n';
import { COLORS } from '../../shared/theme';

export function AccountBar() {
  const ent = useEntitlementStore((s) => s.ent);
  const status = useEntitlementStore((s) => s.status);
  const refresh = useEntitlementStore((s) => s.refresh);
  const lang = useLangStore((s) => s.lang);
  useEffect(() => { void refresh(); }, [refresh]);

  if (status === 'loading') {
    return <span style={{ fontSize: 11, color: '#94a3b8' }}>…</span>;
  }

  if (ent.tier === 'anonymous') {
    return (
      <a href={loginUrl(lang === 'en' ? 'en' : 'zh')}
        title={tr('登录后可使用 AI 方案生成、子电路推荐等功能，并把设计保存到你的空间。未登录同样可以完整体验画布、导入 KiCad 工程与导出原型文件。')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 7,
          border: `1px solid ${COLORS.green}`, background: '#fff', color: COLORS.green,
          fontSize: 12, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap',
        }}>
        🔑 {tr('登录解锁 AI')}
        <span style={{ fontWeight: 400, fontSize: 10, color: '#94a3b8' }}>
          {lang === 'en' ? 'eehub.io' : 'ezplm.cn'}
        </span>
      </a>
    );
  }

  const low = ent.creditsKnown && ent.credits <= 10;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11.5, color: '#475569' }} title={ent.userId}>
        {ent.displayName || tr('已登录')}
      </span>
      <span title={tr('AI 功能按次消耗 Credit；不同功能消耗不同')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 6,
          background: low ? '#fffbeb' : COLORS.greenBg, color: low ? '#b45309' : COLORS.green,
          fontSize: 11.5, fontWeight: 700,
        }}>
        ⚡ {ent.creditsKnown ? ent.credits : tr('余额未知')}
        <span style={{ fontWeight: 400, fontSize: 10 }}>Credit</span>
      </span>
      {low && (
        <a href={buyCreditsUrl(lang === 'en' ? 'en' : 'zh')}
          style={{ fontSize: 11, fontWeight: 700, color: '#b45309', textDecoration: 'none' }}>
          {tr('购买')}
        </a>
      )}
    </div>
  );
}

/**
 * AI 功能被拒时的统一提示。
 * 三种原因给三种出路，不含糊其辞。
 */
export function AiGateNotice({ reason, cost, onClose }: {
  reason: 'login-required' | 'insufficient-credits' | 'credits-unknown';
  cost?: number;
  onClose?: () => void;
}) {
  const lang = useLangStore((s) => s.lang) === 'en' ? 'en' : 'zh';
  const body = reason === 'login-required'
    ? {
        title: tr('AI 功能需要登录'),
        text: tr('未登录可以完整体验画布、导入 KiCad 工程、检索器件库与导出原型文件；AI 生成与云端保存需要登录后使用。新注册赠送体验 Credit。'),
        action: { label: tr('去登录'), href: loginUrl(lang) },
      }
    : reason === 'insufficient-credits'
      ? {
          title: tr('Credit 余额不足'),
          text: `${tr('本次操作需要')} ${cost ?? '—'} Credit。${tr('可购买 Credit 后继续，已完成的设计不受影响。')}`,
          action: { label: tr('购买 Credit'), href: buyCreditsUrl(lang) },
        }
      : {
          title: tr('暂时无法确认额度'),
          text: tr('额度服务未接通，为避免误扣费，AI 功能暂不可用。请稍后再试。'),
          action: null,
        };

  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, background: '#fffbeb', border: '1px solid #fde68a' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e' }}>{body.title}</div>
      <div style={{ fontSize: 10.5, color: '#a16207', lineHeight: 1.6, marginTop: 3 }}>{body.text}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 7 }}>
        {body.action && (
          <a href={body.action.href}
            style={{ padding: '4px 12px', borderRadius: 6, background: COLORS.green, color: '#fff', fontSize: 11, fontWeight: 700, textDecoration: 'none' }}>
            {body.action.label}
          </a>
        )}
        {onClose && (
          <button onClick={onClose}
            style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 11, cursor: 'pointer' }}>
            {tr('知道了')}
          </button>
        )}
      </div>
    </div>
  );
}

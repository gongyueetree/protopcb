import { formatMoney } from '../design-core/money';
/**
 * shared/theme.ts
 * 共享设计令牌与显示常量。
 */
import type { ComponentCategory } from '../design-core/document/types';
import { useLangStore } from './i18n';

export const COLORS = {
  green: '#1f5c3b',
  greenLight: '#2d7c4e',
  greenBg: '#f0f9f4',
  blue: '#2563eb',
  red: '#dc2626',
  amber: '#b45309',
};

/** 类别显示配置（颜色用于画布渲染） */
export const CATEGORY_DISPLAY: Record<ComponentCategory, { name: string; icon: string; color: string }> = {
  mcu: { name: '微控制器', icon: '🔲', color: '#1a6b3c' },
  power: { name: '电源管理', icon: '⚡', color: '#b45309' },
  passive: { name: '无源器件', icon: '◇', color: '#4b5563' },
  connector: { name: '连接器', icon: '⊞', color: '#6d28d9' },
  ic: { name: '集成电路', icon: '◻', color: '#0e7490' },
  electromech: { name: '机电器件', icon: '🔘', color: '#9d174d' },
  sensor: { name: '传感器', icon: '🌡', color: '#0f766e' },
  rf: { name: '射频无线', icon: '📶', color: '#7c3aed' },
};

export const CATEGORY_LIST: ComponentCategory[] = ['mcu', 'power', 'passive', 'connector', 'ic', 'electromech', 'sensor', 'rf'];

/**
 * @deprecated 请改用 design-core/money 的 formatMoney(money, locale)。
 *
 * 旧实现按界面语言切符号（中文 ¥ / 英文 $）却不换数值 —— 一条 CNY 报价切到英文
 * 就被标成美元，是数据错误而不是本地化。这里保留调用点兼容，但**必须带币种**，
 * 缺币种时如实显示"币种未知"，不再默认成本地货币。
 */
export function fmtMoney(amount?: number, currency?: string): string {
  if (amount == null) return '—';
  return formatMoney({ amount, currency }, useLangStore.getState().lang === 'en' ? 'en' : 'zh');
}

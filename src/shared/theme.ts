/**
 * shared/theme.ts
 * 共享设计令牌与显示常量。
 */
import type { ComponentCategory } from '../design-core/document/types';

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
};

export const CATEGORY_LIST: ComponentCategory[] = ['mcu', 'power', 'passive', 'connector', 'ic'];

export function fmtMoney(amount?: number): string {
  return amount == null ? '—' : `¥${amount.toFixed(2)}`;
}

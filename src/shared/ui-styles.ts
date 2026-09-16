/**
 * shared/ui-styles.ts — App 与各面板共用的按钮样式常量（从 App.tsx 抽出）。
 */
import type React from 'react';
import { TOOLBAR_CTRL_H } from './theme';

export const linkBtn: React.CSSProperties = { padding: '5px 12px', borderRadius: 6, border: '1px solid #c6e2d0', background: '#f0f9f4', color: '#1f5c3b', fontSize: 11, fontWeight: 700, textDecoration: 'none' };
export const hbtn: React.CSSProperties = { padding: '5px 12px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
/** 图标工具按钮：无文字，靠 title/aria-label 提供说明 */
export const ibtn: React.CSSProperties = { width: 32, height: TOOLBAR_CTRL_H, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: '1px solid #E8F3EE', background: '#fff', fontSize: 15, lineHeight: 1, color: '#2C3E50', cursor: 'pointer', padding: 0 };
export const smbtn: React.CSSProperties = { padding: '3px 10px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer', color: '#475569' };

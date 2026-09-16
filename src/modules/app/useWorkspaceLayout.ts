/**
 * modules/app/useWorkspaceLayout.ts — 窄屏自适应与左右栏折叠（从 App.tsx 抽出）。
 */
import { useEffect, useState } from 'react';

export function useWorkspaceLayout() {
/**
 * 窄屏自适应：两侧面板按窗口宽度收窄，很窄时直接折叠，把空间让给画布。
 * 手机/分屏上原来两侧各占 330/320px，1000px 宽的窗口只剩 350px 画布，没法用。
 */
  const [winW, setWinW] = useState(typeof window === 'undefined' ? 1600 : window.innerWidth);
  useEffect(() => {
  const on = () => setWinW(window.innerWidth);
  window.addEventListener('resize', on);
  return () => window.removeEventListener('resize', on);
}, []);
  const sideW = winW < 1100 ? { left: 250, right: 250 } : winW < 1400 ? { left: 290, right: 280 } : { left: 330, right: 320 };
  const [leftManual, setLeftManual] = useState<boolean | null>(null);
  const [rightManual, setRightManual] = useState<boolean | null>(null);
  const leftOpen = leftManual ?? winW >= 900;      // 900px 以下默认收起左栏
  const rightOpen = rightManual ?? winW >= 1000;   // 1000px 以下默认收起右栏
  return { winW, sideW, leftOpen, rightOpen, setLeftManual, setRightManual };
}

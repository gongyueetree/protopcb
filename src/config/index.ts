/**
 * config/index.ts
 * 运行模式与环境配置。通过 Vite 环境变量 VITE_APP_MODE 切换。
 * demo | standalone | integrated —— 对应诊断第七节三种模式。
 */
import type { RunMode } from '../design-core/document/types';

export interface AppConfig {
  mode: RunMode;
  providers: {
    // 'local-api' 从未有过实现（factory 对 standalone 也装 Ezplm* HTTP provider），已删除
    component: 'mock' | 'ezplm';
    reference: 'mock' | 'ezplm';
    project: 'local' | 'ezplm';
    /** AI 只有一条真实路径：浏览器 aiRequest → /api/ai → Gemini 执行器。demo 模式允许 Mock 回退 */
    ai: 'gemini-via-api' | 'mock';
    identity: 'demo' | 'ezplm';
  };
  /** integrated/standalone 模式下的后端基址 */
  apiBaseUrl?: string;
}

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};
const MODE = (env.VITE_APP_MODE as RunMode) || 'demo';
const API_BASE = env.VITE_API_BASE_URL;

const PRESETS: Record<RunMode, AppConfig> = {
  demo: {
    mode: 'demo',
    providers: { component: 'mock', reference: 'mock', project: 'local', ai: 'mock', identity: 'demo' },
  },
  standalone: {
    mode: 'standalone',
    // standalone：ezPLM 风格的 HTTP provider 指向本地 server/ 骨架；AI 仍走 /api/ai（没有 'claude' 实现）
    providers: { component: 'ezplm', reference: 'ezplm', project: 'local', ai: 'gemini-via-api', identity: 'ezplm' },
    apiBaseUrl: API_BASE ?? '/api',
  },
  integrated: {
    mode: 'integrated',
    providers: { component: 'ezplm', reference: 'ezplm', project: 'ezplm', ai: 'gemini-via-api', identity: 'ezplm' },
    apiBaseUrl: API_BASE ?? 'https://www.ezplm.cn/api',
  },
};

export const appConfig: AppConfig = PRESETS[MODE] ?? PRESETS.demo;

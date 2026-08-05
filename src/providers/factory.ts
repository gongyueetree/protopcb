/**
 * providers/factory.ts
 * Provider 工厂 —— 根据运行模式装配 ProviderRegistry。
 *
 * demo:        全部 Mock
 * standalone:  组件/参考用本地 API (复用 ezPLM Provider 指向本地后端)，项目用本地存储
 * integrated:  全部 ezPLM Provider，需注入鉴权令牌
 *
 * 页面只通过 getProviders() 获取，不直接 import 具体实现。
 */
import type { ProviderRegistry } from './types';
import { appConfig } from '../config';
import {
  MockComponentDataProvider, MockReferenceDesignProvider, MockIdentityProvider,
  LocalStorageProjectProvider, MockAiModelProvider,
} from './mock';
import { HttpClient } from './http/client';
import { GeminiAiProvider } from './gemini';
import {
  EzplmComponentDataProvider, EzplmReferenceDesignProvider,
  EzplmIdentityProvider, EzplmProjectProvider,
} from './ezplm';

import { getGeminiKey } from './gemini';
import type { AiModelProvider, AiSchemeRequest, AccessContext } from './types';

/** 动态 AI Provider：每次调用时检查 Gemini Key（localStorage/env），有则走 Gemini，无则回退 Mock */
function makeAi(): AiModelProvider {
  const mock = new MockAiModelProvider();
  return {
    async generateScheme(req: AiSchemeRequest, ctx: AccessContext) {
      const key = getGeminiKey();
      if (key) {
        try { return await new GeminiAiProvider(key).generateScheme(req, ctx); }
        catch (e) { console.warn('[AI] Gemini 调用失败，回退 Mock:', e); }
      }
      return (mock.generateScheme as (r: AiSchemeRequest, c?: AccessContext) => ReturnType<AiModelProvider["generateScheme"]>)(req, ctx);
    },
  };
}

let registry: ProviderRegistry | null = null;

/** 鉴权令牌持有者。integrated 模式下由宿主(ezPLM SSO/OIDC票据)注入。 */
let authTokenGetter: (() => string | null) = () => {
  try { return localStorage.getItem('cc:token'); } catch { return null; }
};

export function setAuthTokenGetter(fn: () => string | null) {
  authTokenGetter = fn;
  registry = null; // 强制重建，使新令牌生效
}

function makeHttp(): HttpClient {
  return new HttpClient({
    baseUrl: appConfig.apiBaseUrl ?? '/api',
    getAuthHeaders: (): Record<string, string> => {
      const t = authTokenGetter();
      return t ? { Authorization: `Bearer ${t}` } : {};
    },
    timeoutMs: 15000,
  });
}

export function getProviders(): ProviderRegistry {
  if (registry) return registry;

  if (appConfig.mode === 'integrated') {
    const http = makeHttp();
    registry = {
      identity: new EzplmIdentityProvider(http),
      components: new EzplmComponentDataProvider(http),
      referenceDesigns: new EzplmReferenceDesignProvider(http),
      project: new EzplmProjectProvider(http),
      ai: makeAi(),
    };
  } else if (appConfig.mode === 'standalone') {
    const http = makeHttp(); // 指向本地后端骨架 (server/)
    registry = {
      identity: new EzplmIdentityProvider(http),
      components: new EzplmComponentDataProvider(http),
      referenceDesigns: new EzplmReferenceDesignProvider(http),
      project: new LocalStorageProjectProvider(),
      ai: makeAi(),
    };
  } else {
    registry = {
      identity: new MockIdentityProvider(),
      components: new MockComponentDataProvider(),
      referenceDesigns: new MockReferenceDesignProvider(),
      project: new LocalStorageProjectProvider(),
      ai: makeAi(),
    };
  }
  return registry;
}

/** 测试用：重置单例 */
export function __resetProviders() { registry = null; }

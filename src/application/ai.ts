/**
 * application/ai.ts — AI 能力的应用层门面。
 * 调用走 providers/ai-client 的 aiRequest()；这里只补一个"服务端是否配置了 AI"的探测，
 * UI 不再直接 import providers/gemini。
 */
export { aiRequest, extractJson, AiAccessError } from '../providers/ai-client';
export { geminiAvailable as aiAvailable } from '../providers/gemini';

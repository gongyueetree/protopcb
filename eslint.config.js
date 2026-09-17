/**
 * ESLint flat config —— 本轮起 lint 真实执行（此前 npm run lint 是 echo + exit 0）。
 * 检查范围：TypeScript 推荐规则、React Hooks 规则、明显未使用变量、
 * no-fallthrough、常见 Promise 误用（不开启需要 type-info 的重型规则，保持 CI 轻量）。
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'server/node_modules/**', '*.tsbuildinfo', 'public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-fallthrough': 'error',
      'no-async-promise-executor': 'error',
      'no-misleading-character-class': 'error',
      '@typescript-eslint/no-floating-promises': 'off', // 需要 type-info，见上方说明
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': ['warn', { 'ts-expect-error': 'allow-with-description' }],
    },
  },
  {
    files: ['api/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-fallthrough': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  /* ───────────── 架构门禁（与 tests/architecture-boundaries 同一套规则，lint 阶段就拦） ─────────────
   * flat config 里后出现的同名规则会**整体替换**前面的，所以每个块都要写全自己的 patterns。*/
  {
    // 任何生产源码都不得依赖 Mock（factory 是唯一装配点）
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/providers/factory.ts', 'src/providers/mock/**', '**/*.test.{ts,tsx}', '**/__tests__/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { regex: '(^|/)providers/mock(/|$)', message: '生产源码不得 import providers/mock（只有 factory 可装配）' },
      ] }],
    },
  },
  {
    // Domain 是纯的：不 import providers / modules / state / react / zustand
    files: ['src/design-core/**/*.{ts,tsx}'],
    ignores: ['src/design-core/**/*.test.{ts,tsx}', 'src/design-core/__tests__/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { regex: '(^|/)providers/mock(/|$)', message: '生产源码不得 import providers/mock' },
        { regex: '(^|/)providers(/|$)', message: 'design-core 不得依赖 providers（依赖方向：Provider → Domain）' },
        { regex: '(^|/)modules(/|$)', message: 'design-core 不得依赖 UI modules' },
        { regex: '(^|/)state(/|$)', message: 'design-core 不得依赖 state store' },
        { regex: '^(react|react-dom|zustand)$', message: 'design-core 不得依赖 React/zustand' },
      ] }],
    },
  },
  {
    // Application 层不得反向依赖 UI：它只返回结构化结果，由 UI 决定怎么提示
    files: ['src/application/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { regex: '(^|/)modules(/|$)', message: 'application 不得依赖 modules（UI）；返回结构化结果交由 UI 处理' },
        { regex: '(^|/)providers/mock(/|$)', message: '生产源码不得 import providers/mock' },
      ] }],
    },
  },
  {
    // UI 不直接碰基础设施实现：只能走 application facade / providers/types / factory
    files: ['src/modules/**/*.{ts,tsx}', 'src/App.tsx'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { regex: '(^|/)providers/mock(/|$)', message: '生产 UI 不得依赖 Mock' },
        { regex: '(^|/)providers/gemini(/|$)', message: 'AI 只能经 providers/ai-client 的 aiRequest()；可用性用 application/ai 的 aiAvailable()' },
        { regex: '(^|/)providers/reference-design/ezplm-provider$', message: '参考设计只能经 getProviders().referenceDesigns' },
        { regex: '(^|/)providers/(ezplm/live|ezplm-live|digikey|suppliers|supplier-search|kicad-library)(/|$)', message: 'UI 不得直接依赖具体供应商/库适配器；请走 application/* 服务' },
      ] }],
      // UI 不直接 fetch /api/*：所有 HTTP 细节在 providers/*，UI 只见 application/* 用例
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.name='fetch'] > :first-child[value=/^\\/api\\//], CallExpression[callee.name='fetch'] > TemplateLiteral > TemplateElement:first-child[value.raw=/^\\/api\\//]",
        message: 'UI 不得直接 fetch(/api/...)：请通过 application/* 服务调用 providers 适配器',
      }],
    },
  },
  {
    files: ['**/*.test.{ts,tsx,js}', '**/__tests__/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);

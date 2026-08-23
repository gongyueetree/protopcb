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
    files: ['api/**/*.js', 'scripts/**/*.mjs', 'server/src/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-fallthrough': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['**/*.test.{ts,tsx,js}', '**/__tests__/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);

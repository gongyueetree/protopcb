/// <reference types="vitest" />
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/** 本地开发时取 git 短 SHA；CI/Vercel 上走环境变量 */
function gitShortSha(): string {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; }
}

export default defineConfig({
  // vitest：排除 Playwright 的 e2e/ 目录（它们用 @playwright/test 的 test()，不是 vitest）
  test: { exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'] },
  // 解压 Worker 内部动态 import fflate 会触发 code-splitting，Worker 输出必须用 ES 格式
  worker: { format: 'es' },
  define: {
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'),
    // 构建来源：Vercel / GitHub Actions 注入，本地回落到 git 短 SHA。
    // 线上排查"跑的是哪一版"时，时间戳容易撞，SHA 才是唯一的。
    __BUILD_SHA__: JSON.stringify(
      (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || process.env.BUILD_SHA || '').slice(0, 7)
      || gitShortSha(),
    ),
  },
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@core': path.resolve(__dirname, 'src/design-core'),
      '@providers': path.resolve(__dirname, 'src/providers'),
      '@modules': path.resolve(__dirname, 'src/modules'),
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'], vendor: ['react', 'react-dom', 'zustand', 'immer', 'zod'] },
      },
    },
  },
})

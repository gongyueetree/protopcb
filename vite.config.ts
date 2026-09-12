import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  // 解压 Worker 内部动态 import fflate 会触发 code-splitting，Worker 输出必须用 ES 格式
  worker: { format: 'es' },
  define: { __BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC') },
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

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  define: { __BUILD_STAMP__: JSON.stringify('2026-07-15 21:03 UTC') },
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

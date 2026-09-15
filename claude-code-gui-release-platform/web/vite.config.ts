import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base 决定静态资源前缀，**必须与后端挂载路径一致**，否则资源 404 / 深链白屏。
// dev server 不按 base 走，所以这个错在本地开发时看不出来 —— 只能在真实服务里 curl 资产 URL 才能发现。
//
// 阶段 2 试探期用 VITE_BASE=/admin-next/；正式切换后用默认的 /admin/。
const base = process.env.VITE_BASE || '/admin/'

export default defineConfig({
  plugins: [react()],
  base,
  server: {
    port: 1421,
    strictPort: true,
    // 本地开发直连后端（后端默认跑在 8799）
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:8799',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  clearScreen: false,
})

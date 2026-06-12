import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import path from 'path'

export default defineConfig({
  plugins: [react(), wasm()],
  resolve: {
    alias: {
      '@engine': path.resolve(__dirname, './src/wasm-engine'),
    },
  },
  server: {
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  build: {
    target: 'es2022',
  },
})

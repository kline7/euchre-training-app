import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import path from 'path'

export default defineConfig({
  plugins: [react(), wasm()],
  resolve: {
    alias: {
      '@engine': path.resolve(__dirname, '../engine/pkg'),
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

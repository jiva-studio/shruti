/// <reference types="vitest" />
import { fileURLToPath } from 'node:url'

import legacy from '@vitejs/plugin-legacy'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    minify: true,
    rollupOptions: {
      treeshake: true,
      output: {
        manualChunks() {
          return 'lectorium'
        }
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 8102,
    allowedHosts: ['mobile.lectorium.dev'],
  },
  plugins: [
    vue(),
    legacy()
  ],
  resolve: {
    alias: {
      '@lectorium/mobile': path.resolve(__dirname, './src'),
      '@lectorium/protocol': fileURLToPath(
        new URL('../../libs/protocol', import.meta.url),
      ),
      '@lectorium/dal': fileURLToPath(
        new URL('../../libs/dal', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom'
  }
})

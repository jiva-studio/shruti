/// <reference types="vitest" />
import { fileURLToPath } from 'node:url'

import legacy from '@vitejs/plugin-legacy'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    rollupOptions: {
      treeshake: true,
      output: {
        manualChunks(id) {
          // if (id.includes('@ionic/core/components/')) {
          //   const match = id.match(/@ionic\/core\/components\/([^/]+)/)
          //   if (match) {
          //     return `vendor-ionic-core-${match[1]}`
          //   }
          //   return 'vendor-ionic-core'
          // }
          
          // vendor
          if (id.includes('@ionic/core')) { return 'vendor-ionic-core' }
          if (id.includes('@ionic/vue')) { return 'vendor-ionic-vue' }
          if (id.includes('pouchdb')) { return 'vendor-pouchdb' }

          // app
          if (id.includes('/modules/libs/dal/')) { return 'lectorium-dal' }
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
      '@lectorium/protocol': fileURLToPath(
        new URL('../../libs/protocol', import.meta.url),
      ),
      '@lectorium/dal': fileURLToPath(
        new URL('../../libs/dal', import.meta.url),
      ),
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom'
  }
})

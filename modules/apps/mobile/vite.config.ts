/// <reference types="vitest" />
import { sentryVitePlugin } from '@sentry/vite-plugin'
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
        manualChunks(id) {
          // vendor
          if (id.includes('@ionic/core')) { return 'vendor-ionic-core' }
          if (id.includes('@ionic/vue')) { return 'vendor-ionic-vue' }
          if (id.includes('pouchdb')) { return 'vendor-pouchdb' }

          // lectorium
          return 'lectorium'
        }
      },
    },
    sourcemap: true
  },
  server: {
    host: '0.0.0.0',
    port: 8102,
    allowedHosts: ['mobile.lectorium.dev'],
  },
  plugins: [
    vue(), 
    legacy(), 
    // sentryVitePlugin({
    //   org: 'akdasa-studios',
    //   project: 'lectorium',
    //   release: {
    //     name: process.env.SENTRY_RELEASE || 'unknown',
    //     dist: process.env.SENTRY_DIST || 'unknown',
    //   }
    // })
  ],
  resolve: {
    alias: {
      '@blocks': path.resolve(__dirname, './src/blocks'),
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
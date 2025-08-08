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
          if (!id.includes('node_modules')) return

          // group big families first
          if (id.includes('vue')) return 'vendor-vue'
          if (id.includes('@ionic')) return 'vendor-ionic'
          if (id.includes('@capacitor')) return 'vendor-capacitor'

          // fallback: one chunk per top-level package
          const m = id.split('node_modules/')[1].split('/')
          const pkg = m[0].startsWith('@') ? `${m[0]}/${m[1]}` : m[0]
          return `vendor-${pkg}`
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
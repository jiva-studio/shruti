import { sentryVitePlugin } from '@sentry/vite-plugin'
import legacy from '@vitejs/plugin-legacy'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8')
)

export default defineConfig({
  build: {
    minify: true,
    rollupOptions: {
      treeshake: true,
      // output: {
      //   manualChunks(id) {
      //     // group big families first
      //     if (id.includes('@ionic/vue')) return 'vendor-ionic-vue'
      //     if (id.includes('@ionic/core')) return 'vendor-ionic-core'
      //     if (id.includes('@stencil/core')) return 'vendor-stencil'

      //     // fallback: one chunk per top-level package
      //     if (id.includes('node_modules')) {
      //       const m = id.split('node_modules/')[1].split('/')
      //       const pkg = m[0].startsWith('@') ? m[0].slice(1, m[0].length) : m[0]
      //       return `vendor-${pkg}`
      //     }

      //     // app
      //     if (id.includes('modules/apps/mobile')) { 
      //       if (id.includes('src/pages')) {
      //         const file = path.basename(id)
      //         const dot = file.indexOf('.')
      //         const base = dot === -1 ? file : file.slice(0, dot)
      //         const name = base.toLowerCase().replace('page', '')
      //         return `lectorium-page-${name}`
      //       }
      //       // return 'lectorium' 
      //     }
      //   }
      // },
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
    (version && process.env.BUILD_NUMBER) && sentryVitePlugin({
      org: 'akdasa-studios',
      project: 'lectorium',
      release: {
        name: version || 'unknown',
        dist: process.env.BUILD_NUMBER || 'unknown',
      }
    })
  ],
  resolve: {
    preserveSymlinks: true,
    alias: {
      '@lectorium/mobile':   path.resolve(__dirname, './src'),
      '@blocks':             path.resolve(__dirname, './src/blocks'),

      '@lectorium/dal':      path.resolve(__dirname, './submodules/dal'),
      '@lectorium/protocol': path.resolve(__dirname, './submodules/protocol'),
    },
  },
})
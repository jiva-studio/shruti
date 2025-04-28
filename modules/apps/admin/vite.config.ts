import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

export default defineConfig({
  plugins: [vue(), vueDevTools()],
  resolve: {
    alias: {
      '@shruti/admin': fileURLToPath(new URL('./src', import.meta.url)),
      '@shruti/dal': fileURLToPath(
        new URL('../../libs/dal', import.meta.url),
      ),
      '@shruti/protocol': fileURLToPath(
        new URL('../../libs/protocol', import.meta.url),
      ),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 8100,
    allowedHosts: ['admin.shruti.dev'],
  },
  base: process.env.BASE_URL || '/',
})

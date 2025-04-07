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
    },
  },
  base: process.env.BASE_URL || '/',
})

import { defineConfig } from 'astro/config'
import vue from '@astrojs/vue'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { UI_LOCALES, DEFAULT_LOCALE } from './src/i18n/locales.data.mjs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Regenerate src/data/screenshots.json (the gallery's per-shot top/bottom
// safe-zone band colors, sampled from public/screens/*) on every dev start
// and build. It's a generated, gitignored artifact — without this it drifts
// whenever screenshots change (a missing entry falls back to a wrong default
// band), so derive it from the committed PNGs at build time instead.
const screenshotBands = {
  name: 'screenshot-bands',
  hooks: {
    'astro:config:setup': () => {
      execFileSync('node', [path.join(__dirname, 'scripts/gen-screenshot-bg.mjs')], {
        stdio: 'inherit',
      })
    },
  },
}
const LECTORIUM_ROOT = path.resolve(__dirname, '../mobile/lectorium')
const UI_ROOT = path.resolve(__dirname, '../mobile/ui')
const LIBS_ROOT = path.resolve(__dirname, '../../libs')

// Reuse real source from the monorepo (chat marker parser, pure presentational
// cards) instead of forking. Vite 8 / Rolldown doesn't expand regex alias
// back-references and doesn't fall back `.js`→`.ts`, so resolve `@lectorium/*`,
// `@lib/*` and monorepo-relative `.js` specifiers via a tiny plugin (mirrors
// the mobile app's `lectoriumAlias`).
const SELF = fileURLToPath(import.meta.url) // web root importer for dep resolution

function monorepoSourceAlias() {
  return {
    name: 'lectorium-source-alias',
    enforce: 'pre',
    async resolveId(id, importer) {
      const fromSrc =
        !!importer &&
        (importer.includes('/mobile/lectorium/') ||
          importer.includes('/mobile/ui/') ||
          importer.includes('/modules/libs/'))

      let rewritten = null
      if (id.startsWith('@lectorium/') && !id.startsWith('@lectorium/plugin-')) {
        rewritten = path.resolve(LECTORIUM_ROOT, id.slice('@lectorium/'.length))
      } else if (id.startsWith('@ui/')) {
        rewritten = path.resolve(UI_ROOT, id.slice('@ui/'.length))
      } else if (id.startsWith('@lib/')) {
        rewritten = path.resolve(LIBS_ROOT, id.slice('@lib/'.length))
      } else if ((id.startsWith('./') || id.startsWith('../')) && id.endsWith('.js') && fromSrc) {
        const ts = id.slice(0, -3) + '.ts'
        const r = await this.resolve(ts, importer, { skipSelf: true })
        return r?.id ?? null
      } else if (
        fromSrc &&
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        id !== 'vue' &&
        !id.startsWith('vue/') &&
        !id.startsWith('@vue/')
      ) {
        // bare dep (marked, @tabler/icons-vue) imported by reused app source —
        // resolve from the web project's own node_modules via Node. `vue` is
        // left to Astro's integration (+ resolve.dedupe) for a single instance.
        try {
          return require.resolve(id)
        } catch {
          return null
        }
      }
      if (!rewritten) return null
      let r = await this.resolve(rewritten, importer, { skipSelf: true })
      if (!r && rewritten.endsWith('.js')) {
        r = await this.resolve(rewritten.slice(0, -3) + '.ts', importer, { skipSelf: true })
      }
      return r?.id ?? rewritten
    },
  }
}

// https://astro.build/config
export default defineConfig({
  site: 'https://shruti.app',
  i18n: {
    defaultLocale: DEFAULT_LOCALE,
    locales: UI_LOCALES.map((l) => l.code),
    routing: { prefixDefaultLocale: true },
  },
  redirects: { '/': '/en/' },
  integrations: [
    screenshotBands,
    vue({ appEntrypoint: '/src/vue-app' }),
    sitemap({
      i18n: {
        defaultLocale: DEFAULT_LOCALE,
        locales: Object.fromEntries(UI_LOCALES.map((l) => [l.code, l.hreflang])),
      },
    }),
  ],
  vite: {
    plugins: [monorepoSourceAlias(), tailwindcss()],
    resolve: { dedupe: ['vue'] },
  },
})

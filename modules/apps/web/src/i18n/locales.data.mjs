// Single source of truth for the site's locales. Plain ESM so both
// astro.config.mjs (build config, loaded before Vite/aliases) and the TS
// app code can import it.
//
// Two axes:
//  - UI_LOCALES  — every locale the chrome (landing + /app shell + chat) is
//                  generated and translated in. `code` doubles as the URL
//                  segment (lowercase, BCP-47-ish: `sr-latn`).
//  - CONTENT_LOCALES — locales the lecture CATALOG actually exists in. Catalog
//                  detail pages (lecture / topic / collection) are generated
//                  only in these; other UI locales collapse onto one of them
//                  via reduceLocaleToContentLanguage (uk→ru, everything else→en).
//
// Adding a language = one entry here (+ its ui.ts strings). `hreflang` is the
// BCP-47 tag emitted in <link rel="alternate"> / sitemap / og:locale.

export const UI_LOCALES = [
  { code: 'ru', label: 'Русский', hreflang: 'ru', og: 'ru_RU', dir: 'ltr' },
  { code: 'en', label: 'English', hreflang: 'en', og: 'en_US', dir: 'ltr' },
]

export const CONTENT_LOCALES = ['ru', 'en']

export const DEFAULT_LOCALE = 'en'

export const UI_LOCALE_CODES = UI_LOCALES.map((l) => l.code)

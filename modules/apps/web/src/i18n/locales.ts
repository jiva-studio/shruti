import { reduceLocaleToContentLanguage } from '@lib/domain/services/contentLanguage.js'
import { UI_LOCALES, CONTENT_LOCALES, DEFAULT_LOCALE, UI_LOCALE_CODES } from './locales.data.mjs'

export { UI_LOCALES, CONTENT_LOCALES, DEFAULT_LOCALE, UI_LOCALE_CODES }

export type Lang = (typeof UI_LOCALES)[number]['code']
export type ContentLang = (typeof CONTENT_LOCALES)[number]

/** Collapse a UI locale onto the content language whose catalog it shows.
 *  Single source of truth shared with the mobile app + chat service
 *  (`@lib/domain` reduceLocaleToContentLanguage): ru/uk → ru, else → en. */
export function contentLangFor(code: string): ContentLang {
  return reduceLocaleToContentLanguage(code) as ContentLang
}

/** True for a route that only exists in CONTENT_LOCALES (lecture / topic /
 *  collection detail). Such a page in a non-content UI locale collapses onto
 *  its content language instead of getting its own URL. */
export function isContentLang(code: string): code is ContentLang {
  return (CONTENT_LOCALES as readonly string[]).includes(code)
}

/** Build the URL for `path` (WITHOUT locale prefix, e.g. "/" or "/app/topics")
 *  in `target`. On a content-only route a non-content target collapses to its
 *  content language so the link points at a page that actually exists. */
export function localizePath(path: string, target: string, contentOnly = false): string {
  const seg = contentOnly ? contentLangFor(target) : target
  return path === '/' ? `/${seg}/` : `/${seg}${path}`
}

import { UI_LOCALES } from './locales.data.mjs'
import type { Lang } from './locales'
import { contentLangFor } from './locales'
export type { Lang }
export const languages = Object.fromEntries(UI_LOCALES.map((l) => [l.code, l.label])) as Record<Lang, string>
export const defaultLang: Lang = 'ru'

export const STORE = {
  appStore: 'https://apps.apple.com/app/id6745510353',
  googlePlay: 'https://play.google.com/store/apps/details?id=studio.jiva.shruti',
  // Off-store (no Google services) APK, published by the
  // apps-mobile-offstore.yml workflow to the bucket's public prefix.
  apkDownload: 'https://cdn-s3.shruti.local/public/app/shruti.apk',
  vk: 'https://vk.com/shruti',
  telegram: 'https://t.me/shrutiapp',
  email: 'support@akdasa.studio',
}

import ru from './strings/ru.json'
import en from './strings/en.json'
import uk from './strings/uk.json'
import srLatn from './strings/sr-latn.json'
import srCyrl from './strings/sr-cyrl.json'

export const ui: Record<Lang, Record<string, string>> = {
  ru,
  en,
  uk,
  'sr-latn': srLatn,
  'sr-cyrl': srCyrl,
}

export type UiKey = keyof typeof en

/** Translate a key for `lang`. Fallback chain: requested locale -> its
 *  content language (uk->ru, sr->en) -> English -> the raw key. */
export function useT(lang: Lang) {
  const primary = ui[lang] ?? ui.en
  const collapsed = ui[contentLangFor(lang)] ?? ui.en
  return (key: UiKey): string => primary[key] ?? collapsed[key] ?? ui.en[key] ?? key
}

type FaqList = readonly (readonly [string, string])[]
/** FAQ entries for `lang`, built from the per-locale `faq.N.q` / `faq.N.a`
 *  string keys (8 pairs). */
export function faqFor(lang: Lang): FaqList {
  const t = useT(lang)
  return Array.from(
    { length: 8 },
    (_, i) => [t(`faq.${i + 1}.q` as UiKey), t(`faq.${i + 1}.a` as UiKey)] as const,
  )
}

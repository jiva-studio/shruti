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
  apkDownload: 'https://cdn.shruti.local/public/app/shruti.apk',
  vk: 'https://vk.com/shruti',
  telegram: 'https://t.me/shrutiapp',
  email: 'support@jiva.studio',
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

export interface FaqEntry {
  q: string
  a: string
  /** Optional call-to-action rendered under the answer (label + href).
   *  Used for the "Ask Sadhu" question so readers can try the chat. */
  cta?: { label: string; href: string }
}
/** FAQ entries for `lang`, built from the per-locale `faq.N.q` / `faq.N.a`
 *  string keys (8 pairs). The chat question (#8) also carries a "try it
 *  online" CTA that deep-links to the AI chat page. */
export function faqFor(lang: Lang): FaqEntry[] {
  const t = useT(lang)
  return Array.from({ length: 8 }, (_, i): FaqEntry => {
    const n = i + 1
    const entry: FaqEntry = { q: t(`faq.${n}.q` as UiKey), a: t(`faq.${n}.a` as UiKey) }
    if (n === 8) entry.cta = { label: t('faq.tryOnline' as UiKey), href: `/${lang}/ai` }
    return entry
  })
}

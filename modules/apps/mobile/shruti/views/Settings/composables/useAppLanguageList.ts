import { ref, type Ref } from "vue"
import { SUPPORTED_LOCALES, type SupportedLocale } from "@shruti/i18n/index.js"

export interface SelectorItem {
  id: string
  title: string
}

export interface UseAppLanguageListReturn {
  items: Ref<SelectorItem[]>
}

/**
 * Native autonym for each supported UI locale — the name a locale calls
 * itself, so every entry is legible to its own speakers regardless of the
 * currently active UI language. This is the canonical UI-language list.
 */
const AUTONYMS: Record<SupportedLocale, string> = {
  en: "English",
  ru: "Русский",
  uk: "Українська",
  "sr-Latn": "Srpski",
  "sr-Cyrl": "Српски",
  es: "Español",
  pt: "Português",
  it: "Italiano",
  de: "Deutsch",
  fr: "Français",
  pl: "Polski",
  hu: "Magyar",
  hi: "हिन्दी",
  bn: "বাংলা",
}

/**
 * The UI-language picker source: the app's supported UI locales, each
 * labelled with its native autonym. Driven by the i18n `SUPPORTED_LOCALES`
 * constant (NOT the content-languages DB table, which lists the languages
 * lectures exist in — a different, narrower set). Keeps the picker in sync
 * with the locales the app actually ships translations for.
 */
export function useAppLanguageList(): UseAppLanguageListReturn {
  const items = ref<SelectorItem[]>(
    SUPPORTED_LOCALES.map((code) => ({ id: code, title: AUTONYMS[code] }))
  )

  return { items }
}

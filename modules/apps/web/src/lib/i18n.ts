// The web app's own i18n provider for the few global `$t` keys the reused
// chat components reference (e.g. TranslationNotice). This is the web app
// supplying its i18n the same way the mobile app does (a global `$t`), not a
// fake of the vue-i18n module. Locale is a shared ref the page sets on mount.
import { ref } from 'vue'

export type WebLocale = 'ru' | 'en'
export const webLocale = ref<WebLocale>('ru')

const DICT: Record<WebLocale, Record<string, string>> = {
  ru: {
    'chat.citationMtBadge': 'Машинный перевод',
    'chat.citationViewOriginal': 'Оригинал',
    'chat.citationViewTranslated': 'Перевод',
  },
  en: {
    'chat.citationMtBadge': 'Machine translation',
    'chat.citationViewOriginal': 'Original',
    'chat.citationViewTranslated': 'Translation',
  },
}

export function t(key: string, _params?: Record<string, unknown>): string {
  return DICT[webLocale.value]?.[key] ?? DICT.ru[key] ?? key
}

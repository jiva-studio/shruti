import { createSharedComposable } from '@vueuse/core'
import { createI18n } from 'vue-i18n'
import { locale } from '../locales'

export const useLocalization = createSharedComposable(() => {

  const i18n = createI18n({
    locale: 'ru',
    fallbackLocale: 'en',
    messages: locale,
    pluralizationRules: {
      ru: (choice, choicesLength) =>{
        if (choice === 0) {
          return 0
        }

        const teen = choice > 10 && choice < 20
        const endsWithOne = choice % 10 === 1
        if (!teen && endsWithOne) {
          return 1
        }
        if (!teen && choice % 10 >= 2 && choice % 10 <= 4) {
          return 2
        }

        return choicesLength < 4 ? 2 : 3
      }
    }
  })

  return i18n
})
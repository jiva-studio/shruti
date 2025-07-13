import { watch } from 'vue'
import { Device } from '@capacitor/device'
import { useConfig } from '@blocks/app.config'
import { useLocalization } from '@blocks/app.localization'

export async function setupI18nFeature() {
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const i18n = useLocalization()

  /* -------------------------------------------------------------------------- */
  /*                                    Setup                                   */
  /* -------------------------------------------------------------------------- */

  if (config.appLanguage.value === '??') {
    const languageCode = await Device.getLanguageCode()
    if (['en', 'ru'].includes(languageCode.value)) {
      config.appLanguage.value = languageCode.value
      i18n.global.locale = languageCode.value as 'ru' | 'en'
    } else {
      config.appLanguage.value = 'ru'
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(() => config.appLanguage.value, (newLanguage) => {
    i18n.global.locale = newLanguage as 'ru' | 'en'
  }, { immediate: true })

}
import { useConfig } from '@lectorium/mobile/features/app.config'
import { useI18n } from 'vue-i18n'

export function useUserChangesAppLangSetting() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const i18n = useI18n()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */
  
  function execute(lang: string) {
    config.appLanguage.value = lang
    i18n.locale.value = lang
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    execute,
  }
}
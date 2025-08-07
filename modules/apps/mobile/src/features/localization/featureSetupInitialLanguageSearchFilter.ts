import { useConfig } from '@blocks/app.config'

export function featureSetupInitialLanguageSearchFilter() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */
  if (!config.migrations.value.includes('set-default-search-filter-language')) {
    const savedFilter = config.savedTracksFilter.value
    if (!savedFilter.languages) {
      savedFilter.languages = [config.appLanguage.value]
      config.savedTracksFilter.value = savedFilter
    }
    config.migrations.value.push('set-default-search-filter-language')
  }
}
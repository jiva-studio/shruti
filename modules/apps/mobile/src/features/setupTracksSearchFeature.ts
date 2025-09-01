import { watch } from 'vue'
import { useEventBus } from '@lectorium/mobile/core'
import { storeToRefs } from 'pinia'
import { useConfig } from '@blocks/app.config'
import { useTracksSearchFilters } from '@blocks/app.tracks.search.filters'
import { useTracksSearchResults } from '@blocks/app.tracks.search.results'
import { useTracksCountFeature } from '@blocks/app.tracks.count'

export async function setupTracksSearchFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const eventBus = useEventBus()
  const tracksSearchResults = useTracksSearchResults()
  const tracksSearchFilters = useTracksSearchFilters()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.dictionaryLoad.subscribe(async () => {
    await tracksSearchFilters.load(config.appLanguage.value)
  })

  eventBus.syncComplete.subscribe(async () => {
    await tracksSearchFilters.load(config.appLanguage.value)
    
    if (tracksSearchResults.store.items.length === 0) {
      await tracksSearchResults.load(
        tracksSearchResults.store.filters, 
        config.appLanguage.value
      )
    }
    eventBus.dictionaryLoad.notify()
    useTracksCountFeature().load()
  })

  watch(tracksSearchResults.store.filters, async (value) => {
    tracksSearchResults.load(value, config.appLanguage.value)
  })

  watch(
    storeToRefs(tracksSearchResults.store).pagesLoaded, 
    async (newValue) => 
  {
    if (newValue === 0) { return }
    tracksSearchResults.load(
      tracksSearchResults.store.filters, 
      config.appLanguage.value,
      newValue
    )
  })

  watch(config.appLanguage, async () => {
    await tracksSearchFilters.load(config.appLanguage.value)
    await tracksSearchResults.load(
      tracksSearchResults.store.filters, 
      config.appLanguage.value
    )
  })
}
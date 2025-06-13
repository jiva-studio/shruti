import { watchPausable } from '@vueuse/core'
import { useTrackSearchResultsStore } from './useTrackSearchResultsStore'
import { useConfig } from '@lectorium/mobile/features/app.config'

export function useTrackSearchFiltersPersistenceTask() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const store = useTrackSearchResultsStore()
  const config = useConfig()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  const hook = watchPausable(store.filters, async (v) => {
    config.savedTracksFilter.value = v
  }, { initialState: 'paused' })

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function start() {
    if (config.savedTracksFilter.value) {
      store.filters.query = config.savedTracksFilter.value.query
      store.filters.authors = config.savedTracksFilter.value.authors
      store.filters.sources = config.savedTracksFilter.value.sources
      store.filters.locations = config.savedTracksFilter.value.locations
      store.filters.languages = config.savedTracksFilter.value.languages
      store.filters.duration = config.savedTracksFilter.value.duration
      store.filters.dates = config.savedTracksFilter.value.dates
      store.filters.sort = config.savedTracksFilter.value.sort
    }
    hook.resume()
  }  

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { start }
}
import { IRepository, IndexService, TracksSearchService } from '@shruti/dal/index'
import { useTrackSearchResultsStore } from './useTrackSearchResultsStore'
import { TrackSearchFilters } from '../models/TrackSearchFilters'
import { useSearchResultsLoader } from './useSearchResultsLoader'
import { Duration, Source } from '@shruti/dal/models'
import { createSharedComposable } from '@vueuse/core'

type Options = {
  indexService: IndexService
  tracksService: TracksSearchService
  sourcesRepository: IRepository<Source>
  durationsRepository: IRepository<Duration>
}

export const useTracksSearchResults = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const store = useTrackSearchResultsStore()

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: Options | null = null

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(o: Options) {
    options = o
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function load(
    filters: TrackSearchFilters,
    language: string,
    page: number = 0
  ) {
    if (!options) { throw new Error('useSyncTrackSearchResultsTask is not initialized') }
    try {
      store.isLoading = true
      const searchResultsLoader = useSearchResultsLoader(options)
      const searchResults = await searchResultsLoader.load({ 
        filters, 
        offset: page * 25, 
        language: language
      })
      store.setItems(searchResults, { replace: page === 0 })
    } finally {
      store.isLoading = false
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, load, store }
})
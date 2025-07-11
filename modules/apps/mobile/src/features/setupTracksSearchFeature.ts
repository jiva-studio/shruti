import { useDAL } from '@blocks/app.database/composables/useDAL'
import { useSyncTrackSearchResultsTask } from '@blocks/app.tracks.search.results'
import { useTracksSearchFiltersTask } from '@blocks/app.tracks.search.filters'
import { useConfig } from '@blocks/app.config'

export async function setupTracksSearchFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const config = useConfig()

  useTracksSearchFiltersTask({
    authorsService: dal.authors,
    sourcesService: dal.sources,
    locationsService: dal.locations,
    languagesService: dal.languages,
    durationsService: dal.durations,
    sortMethodsService: dal.sortMethods,
    language: config.appLanguage
  })

  useSyncTrackSearchResultsTask({
    indexService: dal.index,
    tracksService: dal.tracksSearchService,
    sourcesRepository: dal.sources,
    durationsRepository: dal.durations,
    language: config.appLanguage
  })
}
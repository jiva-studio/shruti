import { useDAL } from '../features/app.database/composables/useDAL'
import { useSyncTrackSearchResultsTask } from '../features/tracks.search.results'
import { useConfig } from '../features/app.config'
import { useTracksSearchFiltersTask } from '../features/tracks.search.filters'

export async function initTrackSearchFeature() {

  useTracksSearchFiltersTask({
    authorsService: useDAL().authors,
    sourcesService: useDAL().sources,
    locationsService: useDAL().locations,
    languagesService: useDAL().languages,
    durationsService: useDAL().durations,
    sortMethodsService: useDAL().sortMethods,
    language: useConfig().appLanguage
  })

  useSyncTrackSearchResultsTask({
    indexService: useDAL().index,
    tracksService: useDAL().tracks,
    sourcesService: useDAL().sources,
    durationsService: useDAL().durations,
    language: useConfig().appLanguage
  })
}
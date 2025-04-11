import { createGlobalState } from '@vueuse/core'
import { useDatabase } from '@/app'
import { TracksService } from '@lectorium/dal/services/TracksService'
import { AuthorsService, LanguagesService, LocationsService, SourcesService } from '@lectorium/dal/index'

// TODO: rename to something better
export const useDAL = createGlobalState(() => {
  const database = useDatabase()

  return {
    tracks: new TracksService(database.local.tracks),
    authors: new AuthorsService(database.local.dictionary),
    locations: new LocationsService(database.local.dictionary),
    sources: new SourcesService(database.local.dictionary),
    languages: new LanguagesService(database.local.dictionary),
  }
})
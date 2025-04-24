import { createGlobalState } from '@vueuse/core'
import { useDatabase } from '@/app'
import { 
  AuthorsService, LanguagesService, LocationsService, MediaItemsService,
  PlaylistItemsService, SourcesService, IndexService, TracksService

} from '@lectorium/dal/index'

// TODO: rename to something better
export const useDAL = createGlobalState(() => {
  const database = useDatabase()

  return {
    tracks: new TracksService(database.local.tracks),
    
    // Dictionary
    authors: new AuthorsService(database.local.dictionary),
    locations: new LocationsService(database.local.dictionary),
    sources: new SourcesService(database.local.dictionary),
    languages: new LanguagesService(database.local.dictionary),

    // Index
    index: new IndexService(database.local.index),
    
    // User data
    mediaItems: new MediaItemsService(database.local.userData),
    playlistItems: new PlaylistItemsService(database.local.userData),
  }
})
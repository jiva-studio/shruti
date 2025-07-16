import { createSharedComposable } from '@vueuse/core'
import { useLocalDatabase } from './useLocalDatabase'
import { 
  AuthorsRepository, CachingRepository, DurationsRepository, IndexService, 
  LanguagesRepository, LocationsRepository, MediaItemsRepository, NotesRepository, 
  PlaylistItemsRepository, SortMethodsRepository, SourcesRepository, TagsRepository,
  TracksRepository, TracksSearchService, ArchiveService,
} from '@lectorium/dal/index'

export const useDAL = createSharedComposable(() => {
  const database = useLocalDatabase().get()
  const tracksRepo = new CachingRepository(new TracksRepository(database.tracks))
  const playlistItemsRepo = new PlaylistItemsRepository(database.userData)

  return {
    tracks: tracksRepo,
    tracksSearchService: new TracksSearchService(tracksRepo),
    
    // Dictionary
    tags: new CachingRepository(new TagsRepository(database.dictionary)),
    authors: new CachingRepository(new AuthorsRepository(database.dictionary)),
    sources: new CachingRepository(new SourcesRepository(database.dictionary)),
    locations: new CachingRepository(new LocationsRepository(database.dictionary)),
    languages: new CachingRepository(new LanguagesRepository(database.dictionary)),
    durations: new CachingRepository(new DurationsRepository(database.dictionary)),
    sortMethods: new CachingRepository(new SortMethodsRepository(database.dictionary)),

    // Index
    index: new IndexService(database.index),
    
    // User data
    mediaItems: new MediaItemsRepository(database.userData),
    playlistItems: playlistItemsRepo,
    notes: new NotesRepository(database.userData),

    archiveService: new ArchiveService(playlistItemsRepo),
  }
})
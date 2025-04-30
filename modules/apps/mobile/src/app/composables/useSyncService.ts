import { createGlobalState } from '@vueuse/core'
import { useDatabase, SyncService } from '@lectorium/mobile/app'

export const useSyncService = createGlobalState(() => {
  const database = useDatabase()

  return new SyncService({
    local: {
      tracks: database.local.tracks,
      dictionary: database.local.dictionary,
      index: database.local.index
    },
    remote: {
      tracks: database.remote.tracks,
      dictionary: database.remote.dictionary,
      index: database.remote.index
    }
  })
})
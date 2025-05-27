import { createGlobalState } from '@vueuse/core'
import { SyncService } from '../library/SyncService'
import { useDatabase } from '@lectorium/mobile/features/app.database'

export const useSyncService = createGlobalState(() => {
  const database = useDatabase().get()

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
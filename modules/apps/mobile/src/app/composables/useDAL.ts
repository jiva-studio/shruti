import { createGlobalState } from '@vueuse/core'
import { useDatabase } from '@/app'
import { TracksService } from '@shruti/dal/services/TracksService'

// TODO: rename to something better
export const useDAL = createGlobalState(() => {
  const database = useDatabase()

  return {
    tracks: new TracksService(database.local.tracks)
  }
})
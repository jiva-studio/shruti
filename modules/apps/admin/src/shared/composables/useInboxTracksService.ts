import { InboxTracksRepository } from '@lectorium/dal'
import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from './useDatabase'

export const useInboxTracksService = createSharedComposable(() => {
  const database = useDatabase()
  return new InboxTracksRepository(database.local.inbox)
})

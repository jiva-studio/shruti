import { InboxTracksRepository } from '@lectorium/dal/index'
import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from './useDatabase'

export const useInboxTracksService = createSharedComposable(() => {
  const database = useDatabase()
  return new InboxTracksRepository(database.local.inbox)
})

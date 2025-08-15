import { createSharedComposable } from '@vueuse/core'
import { SourcesRepository } from '@shruti/dal'
import { useDatabase } from '@shruti/admin/shared'

export const useSourcesService = createSharedComposable(() => {
  const database = useDatabase()
  return new SourcesRepository(database.local.dictionary)
})

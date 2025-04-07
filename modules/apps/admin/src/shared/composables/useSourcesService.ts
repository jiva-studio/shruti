import { createSharedComposable } from '@vueuse/core'
import { SourcesService } from '@shruti/dal/index'
import { useDatabase } from '@shruti/admin/shared'

export const useSourcesService = createSharedComposable(() => {
  const database = useDatabase()
  return new SourcesService(database.local.dictionary)
})

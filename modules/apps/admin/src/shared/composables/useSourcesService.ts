import { createSharedComposable } from '@vueuse/core'
import { SourcesRepository } from '@lectorium/dal/index'
import { useDatabase } from '@lectorium/admin/shared'

export const useSourcesService = createSharedComposable(() => {
  const database = useDatabase()
  return new SourcesRepository(database.local.dictionary)
})

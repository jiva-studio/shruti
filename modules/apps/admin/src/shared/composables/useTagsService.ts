import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from '@lectorium/admin/shared'
import { TagsRepository } from '@lectorium/dal'

export const useTagsService = createSharedComposable(() => {
  const database = useDatabase()
  return new TagsRepository(database.local.dictionary)
})

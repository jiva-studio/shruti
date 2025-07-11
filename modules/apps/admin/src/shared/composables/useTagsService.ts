import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from '@lectorium/admin/shared'
import { TagsRepository } from '@lectorium/dal/index'

export const useTagsService = createSharedComposable(() => {
  const database = useDatabase()
  return new TagsRepository(database.local.dictionary)
})

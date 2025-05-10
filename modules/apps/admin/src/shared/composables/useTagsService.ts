import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from '@lectorium/admin/shared'
import { TagsService } from '@lectorium/dal/index'

export const useTagsService = createSharedComposable(() => {
  const database = useDatabase()
  return new TagsService(database.local.dictionary)
})

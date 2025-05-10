import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from '@shruti/admin/shared'
import { TagsService } from '@shruti/dal/index'

export const useTagsService = createSharedComposable(() => {
  const database = useDatabase()
  return new TagsService(database.local.dictionary)
})

import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from '@shruti/admin/shared'
import { TagsRepository } from '@shruti/dal'

export const useTagsService = createSharedComposable(() => {
  const database = useDatabase()
  return new TagsRepository(database.local.dictionary)
})

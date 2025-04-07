import { createSharedComposable } from '@vueuse/core'
import { AuthorsService } from '@shruti/dal/index'
import { useDatabase } from '@shruti/admin/shared'

export const useAuthorsService = createSharedComposable(() => {
  const database = useDatabase()
  return new AuthorsService(database.local.dictionary)
})

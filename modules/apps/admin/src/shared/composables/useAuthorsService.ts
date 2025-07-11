import { createSharedComposable } from '@vueuse/core'
import { AuthorsRepository } from '@shruti/dal/index'
import { useDatabase } from '@shruti/admin/shared'

export const useAuthorsService = createSharedComposable(() => {
  const database = useDatabase()
  return new AuthorsRepository(database.local.dictionary)
})

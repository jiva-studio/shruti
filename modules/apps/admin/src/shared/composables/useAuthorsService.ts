import { createSharedComposable } from '@vueuse/core'
import { AuthorsRepository } from '@lectorium/dal/index'
import { useDatabase } from '@lectorium/admin/shared'

export const useAuthorsService = createSharedComposable(() => {
  const database = useDatabase()
  return new AuthorsRepository(database.local.dictionary)
})

import { createSharedComposable } from '@vueuse/core'
import { AuthorsRepository } from '@lectorium/dal'
import { useDatabase } from '@lectorium/admin/shared'

export const useAuthorsService = createSharedComposable(() => {
  const database = useDatabase()
  return new AuthorsRepository(database.local.dictionary)
})

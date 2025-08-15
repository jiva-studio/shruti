import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from '@lectorium/admin/shared'
import { LocationsRepository } from '@lectorium/dal'

export const useLocationsService = createSharedComposable(() => {
  const database = useDatabase()
  return new LocationsRepository(database.local.dictionary)
})

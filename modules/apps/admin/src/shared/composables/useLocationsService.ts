import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from '@shruti/admin/shared'
import { LocationsRepository } from '@shruti/dal'

export const useLocationsService = createSharedComposable(() => {
  const database = useDatabase()
  return new LocationsRepository(database.local.dictionary)
})

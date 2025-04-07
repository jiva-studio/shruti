import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from '@shruti/admin/shared'
import { LocationsService } from '@shruti/dal/index'

export const useLocationsService = createSharedComposable(() => {
  const database = useDatabase()
  return new LocationsService(database.local.dictionary)
})

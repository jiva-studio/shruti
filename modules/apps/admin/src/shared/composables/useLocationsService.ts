import { createSharedComposable } from '@vueuse/core'
import { useDatabase } from '@lectorium/admin/shared'
import { LocationsService } from '@lectorium/dal/index'

export const useLocationsService = createSharedComposable(() => {
  const database = useDatabase()
  return new LocationsService(database.local.dictionary)
})

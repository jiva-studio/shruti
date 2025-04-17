import { createGlobalState } from '@vueuse/core'
import { DownloaderService, MediaService, useDatabase } from '@/app'
import { MediaItemsService } from '@lectorium/dal/index'

export const useMediaService = createGlobalState(() => {
  const database = useDatabase()

  return new MediaService(
    new MediaItemsService(database.local.userData),
    new DownloaderService(),
  )
})
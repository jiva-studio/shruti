import { createGlobalState } from '@vueuse/core'
import { DownloaderService, MediaService, useDAL } from '@lectorium/mobile/app'

export const useMediaService = createGlobalState(() => {
  const dal = useDAL()

  return new MediaService(
    dal.mediaItems,
    new DownloaderService(),
  )
})
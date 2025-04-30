import { createGlobalState } from '@vueuse/core'
import { DownloaderService, MediaService, useDAL } from '@shruti/mobile/app'

export const useMediaService = createGlobalState(() => {
  const dal = useDAL()

  return new MediaService(
    dal.mediaItems,
    new DownloaderService(),
  )
})
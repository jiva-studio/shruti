import { createGlobalState } from '@vueuse/core'
import { MediaService, useDAL, useDownloaderService } from '@shruti/mobile/app'

export const useMediaService = createGlobalState(() => {
  const dal = useDAL()
  const downloaderService = useDownloaderService()

  return new MediaService(
    dal.mediaItems,
    downloaderService,
  )
})
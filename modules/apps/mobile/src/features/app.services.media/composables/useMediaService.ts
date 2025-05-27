import { createSharedComposable } from '@vueuse/core'
import { MediaService } from '../library/MediaService'
import { useDAL } from '@lectorium/mobile/features/app.database'

// TODO: fix it
import { useDownloaderService } from '../../app.services.download'

export const useMediaService = createSharedComposable(() => {
  const dal = useDAL()
  const downloaderService = useDownloaderService()

  return new MediaService(
    dal.mediaItems,
    downloaderService,
  )
})
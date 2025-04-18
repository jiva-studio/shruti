import { createGlobalState } from '@vueuse/core'
import { UserAddsTrackToPlaylistScenario } from '@/library'
import { useDAL, useMediaService, useBucketService, useConfig } from '@/app'

export const useLibraryScenarios = createGlobalState(() => {
  const dal = useDAL()
  const config = useConfig()
  const mediaService = useMediaService()
  const bucketService = useBucketService()

  return {
    userAddsTrackToPlaylistScenario: 
      new UserAddsTrackToPlaylistScenario(
        dal.tracks, dal.playlistItems,
        mediaService, bucketService,
        config.bucketName.value,
    ),
  }
})
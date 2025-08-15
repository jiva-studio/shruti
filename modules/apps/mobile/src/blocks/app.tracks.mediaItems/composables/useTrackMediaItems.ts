import { IRepository } from '@lectorium/dal'
import { IBucketService } from '@lectorium/mobile/interfaces'
import { MediaItem, Track } from '@lectorium/dal'
import { useTrackMediaItemsUrlSigner } from './useTrackMediaItemsUrlSigner'
import { useTrackMediaItemsCreator } from './useTrackMediaItemsCreator'
import { createSharedComposable } from '@vueuse/core'

type Options = {
  bucketName: string
  bucketService: IBucketService
  tracksRepository: IRepository<Track>
  mediaItemsRepository: IRepository<MediaItem>
}

export const useTrackMediaItems = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: Options | null = null

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(o: Options) {
    options = o
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Creates media items for a track.
   * @param trackId Track ID for which media items should be created.
   * @returns List of created media items.
   */
  async function createMediaItems(
    trackId: string,
  ): Promise<MediaItem[]> {
    if (!options) { throw new Error('useTrackMediaItems is not initialized. Call init(options) first.') }
    const trackMediaUrlSigner = useTrackMediaItemsUrlSigner({
      bucketName: options.bucketName,
      bucketService: options.bucketService,
      tracksRepository: options.tracksRepository,
    })
    const trackMediaItemCreator = useTrackMediaItemsCreator({
      mediaItemsRepository: options.mediaItemsRepository,
    })

    const signedMediaUrls = await trackMediaUrlSigner.getTrackSignedMediaUrls(trackId)
    return await trackMediaItemCreator.createMediaItems(trackId, signedMediaUrls)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, createMediaItems }
})

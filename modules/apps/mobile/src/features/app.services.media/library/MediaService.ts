import { MediaItemsService } from '@lectorium/dal/index'
import { useIdGenerator } from '@lectorium/mobile/features/app.core'
import { IDownloaderService, IMediaService } from '@lectorium/mobile/interfaces'

export type GetMediaRequest = {
  trackId: string,
  url: string
  destination: string
}

/**
 * MediaService is responsible for managing media items and their download status.
 */
export class MediaService implements IMediaService {

  /**
   * Initializes a new instance of the MediaService class.
   * @param mediaItems Media items service
   * @param downloader Downloader service
   */
  constructor(
    private readonly mediaItems: MediaItemsService,
    private readonly downloader: IDownloaderService
  ) {
    downloader.completedEvent.subscribe(async e => { 
      await this.mediaItems.patchOne(e.meta.mediaItemId, { state: 'ready' })
    })
    downloader.failedEvent.subscribe(async e => { 
      await this.mediaItems.patchOne(e.meta.mediaItemId, { state: 'failed' })
    })
  }

  /**
   * Gets media item.
   * @param request Request of getting media item
   */
  async get(
    request: GetMediaRequest
  ): Promise<void> {
    if (!request.trackId) { throw new Error('No trackId provided') }

    // check if media item already exists
    const mediaItem = await this.mediaItems.findOne({ 
      localPath: request.destination 
    })
    if (mediaItem && mediaItem.state === 'failed') {
      // Media item failed, remove it and start download again
      await this.mediaItems.removeOne(mediaItem._id)
    } else if (mediaItem) {
      return // Media item already exists, do nothing
    }
     
    // add to media items
    const newMediaItemId = useIdGenerator().generateId(22)
    await this.mediaItems.addOne({
      _id: newMediaItemId, 
      type: 'mediaItem',
      remoteUrl: request.url,
      localPath: request.destination,
      trackId: request.trackId,
      state: 'pending'
    })

    // start download
    console.log('Download starting: ', JSON.stringify(request))
    await this.downloader.enqueue({
      url: request.url,
      destination: request.destination,
      meta: {
        trackId: request.trackId,
        mediaItemId: newMediaItemId,
      }
    })
  }
}
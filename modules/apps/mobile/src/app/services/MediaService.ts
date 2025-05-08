import { MediaItemsService } from '@lectorium/dal/index'
import { DownloaderService, useIdGenerator } from '@lectorium/mobile/app'

export type GetMediaRequest = {
  trackId: string,
  url: string
  destination: string
  title: string
}

/**
 * MediaService is responsible for managing media items and their download status.
 */
export class MediaService {

  /**
   * Initializes a new instance of the MediaService class.
   * @param mediaItems Media items service
   * @param downloader Downloader service
   */
  constructor(
    private readonly mediaItems: MediaItemsService,
    private readonly downloader: DownloaderService
  ) { }

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
      title: request.title,
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
      title: request.title,
      meta: {
        trackId: request.trackId,
        mediaItemId: newMediaItemId,
      }
    })
  }
}
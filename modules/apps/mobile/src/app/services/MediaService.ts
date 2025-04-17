import { MediaItemsService } from '@lectorium/dal/index'
import { DownloaderService, DownloaderTaskStatuses } from '@/app'
import { MediaItem } from '@lectorium/dal/models'

export type GetMediaRequest = {
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
  ) {
    downloader.onDownloadComplete(
      async ({ taskId, status }) => await this.onMediaItemDownloadComplete(taskId, status) 
    )
  }

  /**
   * Gets media item.
   * @param request Request of getting media item
   */
  async get(
    request: GetMediaRequest
  ): Promise<void> {
    // TODO: get hash of desrtination and use it as id
    const mediaItemId = request.destination

    // check if media item already exists
    const mediaItem = await this.mediaItems.findOne({ _id: mediaItemId })
    if (mediaItem && mediaItem.status === 'failed') {
      // Media item failed, remove it and start download again
      await this.mediaItems.removeOne(mediaItemId)
    } else if (mediaItem) {
      return // Media item already exists, do nothing
    }
      
    // start download
    const downloaderResponse =
      await this.downloader.enqueue(request)

    // add to media items
    await this.mediaItems.addOne({
      _id: mediaItemId,
      taskId: downloaderResponse.taskId,
      type: 'mediaItem',
      title: request.title,
      remoteUrl: request.url,
      localPath: request.destination,
      status: 'pending',
    })
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Private                                  */
  /* -------------------------------------------------------------------------- */

  private async onMediaItemDownloadComplete(
    taskId: string,
    status: DownloaderTaskStatuses
  ) {
    const statusesMap: 
      Record<
        DownloaderTaskStatuses, 
        MediaItem['status']
      > = {
        pending: 'pending',
        running: 'downloading',
        successful: 'available',
        failed: 'failed',
        paused: 'paused'
      }

    // get media item by taskId
    const mediaItem = await this.mediaItems.findOne({ taskId })
    console.log(
      `Download ${taskId} completed with status: `+
      `${mediaItem?.status ?? 'unknown'} -> ${status}`)

    // update media item status if necessary
    if (mediaItem && mediaItem.status !== status) {
      mediaItem.status = statusesMap[status]
      await this.mediaItems.updateOne(mediaItem._id, mediaItem)
      console.log('Media item status updated:', mediaItem._id, mediaItem.status)
    } 
  }
}
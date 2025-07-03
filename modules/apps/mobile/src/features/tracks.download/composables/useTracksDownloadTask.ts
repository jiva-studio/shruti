import { MediaItemsService, TracksService } from '@lectorium/dal/index'
import { S3Operation } from '@lectorium/protocol/s3'
import { IBucketService } from '@lectorium/mobile/interfaces'
import { Events } from '@lectorium/mobile/events'
import { useLogger } from '@lectorium/mobile/features/app.core'
import { createSharedComposable } from '@vueuse/core'

export type Options = {
  trackDownloadFailedEvent: typeof Events.trackDownloadFailed
  downloaderTaskFailedEvent: typeof Events.downloaderTaskFailed
  downloaderTaskCompletedEvent: typeof Events.downloaderTaskCompleted
  downloaderTaskEnqueueRequestedEvent: typeof Events.downloaderTaskEnqueueRequested
  bucketName: () => string
  bucketService: () => IBucketService
  tracksService: () => TracksService
  mediaItemsService: () => MediaItemsService
  uniqueIdGenerator: () => string
}

export const useTracksDownloadTask = createSharedComposable((options: Options) => {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'tracks.download' })

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  async function download(trackId: string) {  
    try {
      logger.info(`Track download requested: ${trackId}`)
      await downloadTrack(trackId)
    } catch (error) {
      logger.error(`Track download failed: ${trackId}, error: ${JSON.stringify(error)}`)
      options.trackDownloadFailedEvent.notify({ trackId })
    }
  }

  options.downloaderTaskCompletedEvent.subscribe(async (task) => {
    if (task.meta && task.meta.mediaItemId) {
      await options.mediaItemsService().patchOne(task.meta.mediaItemId, {
        state: 'ready',
      })
    }
  })

  options.downloaderTaskFailedEvent.subscribe(async (task) => {
    if (task.meta && task.meta.mediaItemId) {
      await options.mediaItemsService().patchOne(task.meta.mediaItemId, {
        state: 'failed',
      })
    }
  })

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function downloadTrack(trackId: string) {
    // Get track information
    const track = await options.tracksService().getOne(trackId)
    const transcripts = Object.values(track.transcripts)

    // Sign all urls and prepare download tasks for MediaService
    const downloadTasks = await Promise.all(
      [
        // Sign url to download original audio file
        { 
          path: track.audio.original.path,
        },

        // Sign url to download transcripts
        ...transcripts.map(transcript => ({
          path: transcript.path,
        }))
      ].map(async (file) => {
        const response = await options.bucketService().getSignedUrl({
          key: file.path,
          bucketName: options.bucketName(),
          expiresIn: 60 * 60 * 24,
          operation: S3Operation.GetObject,
        })
        return {
          url: response.signedUrl,
          destination: file.path,
        }
      })
    )

    // Download all files using MediaService and prepared task infos from above
    for (const task of downloadTasks) {
      const mediaItem = await options.mediaItemsService().findOne({ 
        localPath: task.destination 
      })
      if (mediaItem && mediaItem.state === 'failed') {
        // Media item failed, remove it and start download again
        await options.mediaItemsService().removeOne(mediaItem._id)
      } else if (mediaItem) {
        continue
      }
        
      // add to media items
      const newMediaItemId = options.uniqueIdGenerator()
      await options.mediaItemsService().addOne({
        _id: newMediaItemId, 
        type: 'mediaItem',
        remoteUrl: task.url,
        localPath: task.destination,
        trackId: trackId,
        state: 'pending'
      })

      // start download
      logger.info('Download starting: ' + JSON.stringify(task))
      options.downloaderTaskEnqueueRequestedEvent.notify({
        url: task.url,
        destination: task.destination,
        meta: {
          trackId: trackId,
          mediaItemId: newMediaItemId,
        }
      })
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { download }
})
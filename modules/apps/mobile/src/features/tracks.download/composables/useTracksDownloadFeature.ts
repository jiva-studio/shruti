import { createSharedComposable } from '@vueuse/core'
import { TracksService } from '@lectorium/dal/index'
import { S3Operation } from '@lectorium/protocol/s3'
import { IBucketService, IMediaService } from '@lectorium/mobile/interfaces'

export type Options = {
  bucketName: string
  tracksService: TracksService
  bucketService: IBucketService
  mediaService: IMediaService
  onTrackFailed?: (trackId: string) => void
}

export const useTracksDownloadFeature = createSharedComposable(() => {
  let _options: Options|undefined = undefined

  function init(options: Options) {
    _options = options
  }

  async function download(item: { trackId: string }) {
    if (!_options) { throw new Error('TracksDownloadFeature not initialized') }
    const o = _options

    try {
      // Get track information
      const track = await o.tracksService.getOne(item.trackId)
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
          const response = await o.bucketService.getSignedUrl({
            key: file.path,
            bucketName: o.bucketName,
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
      await Promise.all(
        downloadTasks.map(async (task) => {
          await o.mediaService.get({ trackId: item.trackId, ...task })
        })
      )
    } catch {
      _options.onTrackFailed?.(item.trackId)
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, download }
})
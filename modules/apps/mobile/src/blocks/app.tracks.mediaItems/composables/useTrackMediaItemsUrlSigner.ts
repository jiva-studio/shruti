import { Track } from '@lectorium/dal'
import { IRepository } from '@lectorium/dal'
import { S3Operation } from '@lectorium/protocol/s3'
import { IBucketService } from '@lectorium/mobile/interfaces'
import { TrackMediaSignedUrl } from '../models/TrackMediaSignedUrl'

type Options = {
  bucketName: string
  bucketService: IBucketService
  tracksRepository: IRepository<Track>
}

export function useTrackMediaItemsUrlSigner({
  bucketName,
  bucketService,
  tracksRepository
}: Options) {
  
  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Returns signed URLs for media files of a track.
   * @param trackId ID of the track to get signed media URLs for
   * @returns List of signed URLs for track's media files
   */
  async function getTrackSignedMediaUrls(
    trackId: string
  ): Promise<TrackMediaSignedUrl[]> {
    const track = await tracksRepository.getOne(trackId)
    const transcripts = Object.values(track.transcripts)

    // Sign all urls and prepare download tasks for MediaService
    return await Promise.all(
      [
        // Sign url to download original audio file
        { 
          path: track.audio.clean?.path || 
                track.audio.original.path,
        },

        // Sign url to download transcripts
        ...transcripts.map(transcript => ({
          path: transcript.path,
        }))
      ].map(async (file) => {
        const response = await bucketService.getSignedUrl({
          key: file.path,
          bucketName: bucketName,
          expiresIn: 60 * 60 * 24,
          operation: S3Operation.GetObject,
        })
        return {
          url: response.signedUrl,
          path: file.path,
        }
      })
    )
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { getTrackSignedMediaUrls }
}

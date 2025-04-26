import { useDAL, useBucketService, useConfig, useMediaService } from '@/app'
import { S3Operation } from '@lectorium/protocol/index'


export function useUserRedownloadsFailedMediaItemsScenario() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const config = useConfig()
  const mediaService = useMediaService()
  const bucketService = useBucketService()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function execute(
    trackId: string
  ) {
    const track = await dal.tracks.getOne(trackId)
    const trackTitle = track.title[config.appLanguage.value] 
      || track.title['en']
      || 'Unknown'
  
    const signedUrl = await bucketService.getSignedUrl({
      key: track.audio.original.path,
      bucketName: config.bucketName.value,
      expiresIn: 60 * 60 * 24,
      operation: S3Operation.GetObject,
    })

    // Enqueue related media to download
    // TODO: add support for multiple media items
    await mediaService.get({
      trackId: trackId,
      url: signedUrl.signedUrl, 
      destination: track.audio.original.path,
      title: trackTitle,
    })

    // Download all related transcripts
    // TODO: download only transcript in language of the user selected in settings
    for (const transcript of Object.values(track.transcripts)) {
      const signedUrl = await bucketService.getSignedUrl({
        key: transcript.path,
        bucketName: config.bucketName.value,
        expiresIn: 60 * 60 * 24,
        operation: S3Operation.GetObject,
      })
      await mediaService.get({
        trackId: trackId,
        url: signedUrl.signedUrl, 
        destination: transcript.path,
        title: trackTitle, 
      })
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { execute }
}
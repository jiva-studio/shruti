import { useDAL, useBucketService, useConfig, useMediaService } from '@/app'
import { S3Operation } from '@lectorium/protocol/index'

/**
 * Scenario for adding a track to a playlist.
 */
export function useUserAddsTrackToPlaylistScenario() {
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
    trackId: string,
  ) {
    // Add track to playlist, or exit if it already exists
    const existingPlayListItem = await dal.playlistItems.findOne({ _id: trackId })
    if (existingPlayListItem) { return }

    // Get track information
    const track = await dal.tracks.getOne(trackId)
    const trackTitle = track.title[config.appLanguage.value] 
      || track.title['en']
      || 'Unknown'

    // Add track to playlist
    await dal.playlistItems.addOne({
      _id: trackId,
      trackId: trackId,
      type: 'playlistItem',
      order: 0,
      played: 0,
      completedAt: undefined
    })

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

  return {
    execute
  }
}
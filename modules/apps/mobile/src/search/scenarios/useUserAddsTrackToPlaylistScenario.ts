import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { useDAL, useBucketService, useConfig, useMediaService } from '@lectorium/mobile/app'
import { useTrackStateStore } from '@lectorium/mobile/app/stores'
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
  const trackStateStore = useTrackStateStore()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function execute(
    trackId: string,
  ) {
    try {
      // Add track to playlist, or exit if it already exists
      const existingPlayListItem = await dal.playlistItems.findOne({ _id: trackId })
      if (existingPlayListItem) { return }

      // Notify user
      await Haptics.impact({ style: ImpactStyle.Light })

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
        played: 0,
        addedAt: Date.now(),
        completedAt: undefined
      })
      trackStateStore.setStatus(trackId, { 
        inPlaylist: true, 
        downloadProgress: 0,
      })

      const transcripts = Object.values(track.transcripts)

      // Sign all urls and prepare download tasks for MediaService
      const downloadTasks = await Promise.all(
        [
          { 
            path: track.audio.original.path,
            title: trackTitle,
          },
          ...transcripts.map(transcript => ({
            path: transcript.path,
            title: trackTitle, // TODO: add "transcript:" prefix + "(language)" postfix
          }))
        ].map(async (file) => {
          const response = await bucketService.getSignedUrl({
            key: file.path,
            bucketName: config.bucketName.value,
            expiresIn: 60 * 60 * 24,
            operation: S3Operation.GetObject,
          })
          return {
            url: response.signedUrl,
            destination: file.path,
            title: file.title, 
          }
        })
      )

      // Download all files using MediaService and prepared tasks
      // from above
      await Promise.all(
        downloadTasks.map(async (task) => {
          await mediaService.get({ trackId: trackId, ...task })
        })
      )
    } catch {
      // Something wrong happened
      trackStateStore.setStatus(trackId, { 
        inPlaylist: true, 
        downloadFailed: true,
        downloadProgress: undefined
      }) 
    }
    
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    execute,
  }
}
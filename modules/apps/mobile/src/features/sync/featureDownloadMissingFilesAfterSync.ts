import { useEventBus } from '@shruti/mobile/core'
import { useSyncMedia } from '@blocks/app.sync.media'
import { useTracksState } from '@blocks/app.tracks.state'

export async function featureDownloadMissingFilesAfterSync() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const eventBus = useEventBus()
  const syncMedia = useSyncMedia()
  const tracksState = useTracksState()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.syncComplete.subscribe(async () => {
    const result = await syncMedia.checkTracksWithoutMedia()
    result.newTrackIds.forEach(x => tracksState.store.setState(x, { downloadProgress: 0 }))
    if (result.newTrackIds.length > 0) {
      eventBus.trackDownload.notify({ 
        trackIds: result.newTrackIds, 
        skipFailed: true, 
        showError: false 
      })
    }
  })
}
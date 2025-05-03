import { useTrackStateStore } from '@lectorium/mobile/app/stores'
import { useDAL } from '@lectorium/mobile/app'

export function useRestoreTracksStatuses() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const trackStateStore = useTrackStateStore()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function init() {
    const items = await dal.playlistItems.getAll()
    for (const item of items) {
      // track is in playlist, mark it
      trackStateStore.setStatus(item.trackId, { inPlaylist: true })

      // check status of media items
      const mediaItems = await dal.mediaItems.getMany({ selector: { trackId: item.trackId } })
      const isMediaItemInFailed = mediaItems.some(x => x.taskStatus === 'failed')
      const noMediaItems = mediaItems.length === 0

      if (noMediaItems || isMediaItemInFailed) {
        trackStateStore.setStatus(item.trackId, { downloadFailed: true })
      }
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    init
  }
}
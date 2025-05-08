import { useTrackStateStore } from '@lectorium/mobile/app/stores'
import { useDAL } from '@lectorium/mobile/app'

/**
 * This feature is responsible for showing the status of tracks indicating
 * that they are in a playlist.
 */
export function useShowTrackInPlaylistStatusFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const trackStateStore = useTrackStateStore()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.playlistItems.subscribe(async (event) => {
    if (event.event === 'added') {
      trackStateStore.setStatus(event.item.trackId, { inPlaylist: true })
    } else if (event.event === 'removed') {
      trackStateStore.setStatus(event.item.trackId, { inPlaylist: false })
    }
  })

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function init() {
    const items = await dal.playlistItems.getAll()
    for (const item of items) {
      // track is in playlist, mark it
      trackStateStore.setStatus(item.trackId, { inPlaylist: true })
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    init
  }
}
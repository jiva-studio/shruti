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
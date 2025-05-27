import { useDAL } from '@lectorium/mobile/features/app.database'
import { watch } from 'vue'
import { usePlayerControls } from '@lectorium/mobile/features/player'

export function useMarkCompletedPlaylistItem() {
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL() // TODO: useDAL should be injected as a dependency
  const player = usePlayerControls()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(player.position, async (pos) => {
    const isTrackAlmostCompleted = player.duration.value - pos < 10

    if (isTrackAlmostCompleted) {
      const playListItem = await dal.playlistItems.getOne(player.playlistItemId.value)
      if (playListItem.completedAt) { 
        return // If completedAt is already set, do not update it again
      }
      playListItem.completedAt = Date.now()
      await dal.playlistItems.updateOne(playListItem._id, playListItem)
    }
  })
}
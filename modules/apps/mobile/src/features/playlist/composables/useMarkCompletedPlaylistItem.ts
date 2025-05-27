import { useDAL } from '@lectorium/mobile/features/app.database'
import { watch } from 'vue'
import { usePlayerControls } from '@lectorium/mobile/features/player'

export function useMarkCompletedPlaylistItem() {
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const player = usePlayerControls()
  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(player.position, async (pos) => {
    if (pos >= player.duration.value) {
      const playListItem = await dal.playlistItems.getOne(player.playlistItemId.value) 
      playListItem.completedAt = Date.now()
      await dal.playlistItems.updateOne(playListItem._id, playListItem)
    }
  })
}
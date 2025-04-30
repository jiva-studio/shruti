import { usePlayerControls } from '@shruti/mobile/player'
import { watch } from 'vue'
import { useDAL } from '@shruti/mobile/app'

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
      const playListItem = await dal.playlistItems.getOne(player.trackId.value) 
      playListItem.completedAt = Date.now()
      await dal.playlistItems.updateOne(playListItem._id, playListItem)
    }
  })
}
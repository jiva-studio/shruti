import { watch } from 'vue'
import { useEventBus } from '@shruti/mobile/core'
import { useDAL } from '@blocks/app.database'
import { useConfig } from '@blocks/app.config'
import { usePlayer } from '@blocks/app.player'
import { usePlaylist } from '@blocks/app.playlist'

export async function setupPlaylistFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const config = useConfig()
  const player = usePlayer()
  const playlist = usePlaylist()
  const eventBus = useEventBus()
 
  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.playlistLoad.subscribe(async () => {
    await playlist.load(config.appLanguage.value)
    eventBus.playlistLoadEnd.notify()
  })

  /* ---------------------------- Mark As Completed --------------------------- */

  watch(player.position, async (pos) => {
    if (player.duration.value === 0 || player.duration.value === undefined) { return }
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

  watch(config.appLanguage, () => {
    eventBus.playlistLoad.notify()
  })

  dal.playlistItems.subscribe(async () => {
    eventBus.playlistLoad.notify()
  })

  /* ----------------------- Archive Old Playlist Items ----------------------- */

  eventBus.playlistArchive.subscribe(async () => { 
    // Get items that were completed more than 24 hours ago
    const oneDayInMs = 24 * 60 * 60 * 1000
    const date = Date.now() - oneDayInMs

    // Get old completed items
    const completedPlaylistItems = await dal.playlistItems.getMany({
      selector: {
        completedAt: { $lte: date },
        archivedAt: { $exists: false }
      }
    })

    // Archive all completed items
    await Promise.all(
      completedPlaylistItems.map(async x => await dal.archiveService.archiveOne(x._id))
    )
  })

  /* --------------------------- Remove Media Items --------------------------- */

  dal.playlistItems.subscribe(async x => {
    const isRemoved = x.event === 'removed'
    const isArchived = x.item.archivedAt !== undefined
    if (isRemoved || isArchived) {
      // TODO: it will return first page only
      // Get all media items related to 
      const mediaItems = await dal.mediaItems.getMany({
        selector: {
          trackId: x.item.trackId
        }
      })

      // Remove all media items
      await Promise.all(
        mediaItems.map(async x => await dal.mediaItems.removeOne(x._id))
      )
    }
  })

}
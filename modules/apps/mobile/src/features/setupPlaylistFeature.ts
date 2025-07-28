import { watch } from 'vue'
import { useEventBus } from '@lectorium/mobile/core'
import { useDAL } from '@blocks/app.database'
import { useConfig } from '@blocks/app.config'
import { usePlaylist, usePlaylistStore } from '@blocks/app.playlist'

export async function setupPlaylistFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const config = useConfig()
  const playlist = usePlaylist()
  const eventBus = useEventBus()
  const playlistStore = usePlaylistStore()
 
  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  // Loads all playlist items
  eventBus.playlistLoad.subscribe(async () => {
    await playlist.load(config.appLanguage.value)
    eventBus.playlistLoadEnd.notify()
  })

  /* --------------------------------- Archive -------------------------------- */

  eventBus.playlistArchiveItem.subscribe(async ({ playlistItemId }) => {
    playlistStore.remove(playlistItemId)
    await dal.archiveService.archiveOne(playlistItemId)

    // If the archived item is currently playing, stop the player
    // if (player.playlistItemId.value === playlistItemId) {
    //   await player.close()
    // }
  })


  /* ---------------------------- Mark As Completed --------------------------- */

  watch(config.appLanguage, () => {
    eventBus.playlistLoad.notify()
  })

  dal.playlistItems.subscribe(async (event) => {
    if (event.event === 'added' || event.event === 'removed') {
      eventBus.playlistLoad.notify()
    }
  })

  /* ----------------------- Archive Old Playlist Items ----------------------- */

  eventBus.playlistArchiveCompleted.subscribe(async () => { 
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
      // Get all media items related to 
      const mediaItems = await dal.mediaItems.getMany({
        selector: { trackId: x.item.trackId },
        limit: 1000 // TODO: it will return first page only
      })

      // Remove all media items
      await Promise.all(
        mediaItems.map(async x => await dal.mediaItems.removeOne(x._id))
      )
    }
  })

}
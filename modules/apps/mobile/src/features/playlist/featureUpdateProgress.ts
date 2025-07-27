import { Status } from '@shruti/audio-player'
import { useDAL } from '@blocks/app.database'
import { usePlayer } from '@blocks/app.player'
import { usePlaylistStore } from '@blocks/app.playlist'

/**
 * Updates playback progress of a playlist item when it is playing.
 */
export function featureUpdateProgress() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const player = usePlayer()
  const playlistStore = usePlaylistStore()

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let lastEvent: Status | null = null

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  player.progress.subscribe(async (event: Status) => {
    if (!event.itemId) { return } // nothong is playng

    // Helper function to get progress
    const getProgress = (e: Status) => {
      const progressSaved   = playlistStore.getState(e.itemId).progress || 0 
      const progressCurrent = e.position / e.duration * 100
      return Math.max(progressSaved, progressCurrent)
    }

    // Set state progress in store
    playlistStore.setState(event.itemId, { progress: getProgress(event) })

    // Save playlist item if required
    if (lastEvent && lastEvent.itemId !== event.itemId) {
      await savePlaylistItemPlaybackProgress(lastEvent.itemId, getProgress(lastEvent))
    } else if (lastEvent && lastEvent.itemId === event.itemId && lastEvent.playing && !event.playing) {
      await savePlaylistItemPlaybackProgress(event.itemId, getProgress(event))
    }

    // Save last event
    lastEvent = event
  })

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Save playback progress for a specific playlist item.
   * @param playlistItemId Playlist item ID to save progress for
   * @param progress Playback progress percentage
   */
  const savePlaylistItemPlaybackProgress = async (
    playlistItemId: string,
    progress: number
  ) => {
    if (progress < 100) {
      await dal.playlistItems.patchOne(playlistItemId, { progress })
    } else {
      await dal.playlistItems.patchOne(playlistItemId, { progress: 100, completedAt: Date.now() })
    }
  }
}
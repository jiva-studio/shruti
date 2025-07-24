import { watch } from 'vue'
import { useEventBus } from '@lectorium/mobile/core'
import { useDAL } from '@blocks/app.database'
import { useTracksState } from '@blocks/app.tracks.state'
import { usePlayer } from '@blocks/app.player'

export function setupTracksStateFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const player = usePlayer()
  const eventBus = useEventBus()
  const tracksState = useTracksState()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.playlistItems.subscribe(async ({ event, item }) => {
    if (event === 'added') { 
     tracksState.store.setState(item.trackId, { inPlaylist: true, downloadProgress: 0 })
    }
    if (event === 'removed') { 
      tracksState.store.setState(item.trackId, { 
        inPlaylist: false, 
        isFailed: undefined 
      })
    }
    if (event === 'updated' && item.completedAt !== undefined) {
      tracksState.store.setState(item.trackId, { isCompleted: true })
    }
    if (event === 'updated' && item.archivedAt !== undefined) { 
      tracksState.store.setState(item.trackId, { 
        inPlaylist: false, 
        isFailed: undefined 
      })
    }
  })

  eventBus.trackStateLoad.subscribe(async (groups: string[]) => {
    await tracksState.load(groups)
  })

  watch(player.isPlaying, async (value) => {
    if (value) { return }
    if (!player.playlistItemId.value) { return }
    if (player.duration.value <= 0) { return }
    if (player.position.value <= 0) { return }

    const progressCurrent = player.position.value / player.duration.value * 100
    await dal.playlistItems.patchOne(
      player.playlistItemId.value, { progress: progressCurrent }
    )
  })

  player.progress.subscribe(async (event) => {
    if (!event.trackId) { return }
    const progressSaved   = tracksState.store.getState(event.trackId).playbackProgress || 0
    const progressCurrent = player.position.value / player.duration.value * 100
    tracksState.store.setState(event.trackId, { 
      playbackProgress: Math.max(progressSaved, progressCurrent)
    })
  })

  /* -------------------------------------------------------------------------- */
  /*                                    Setup                                   */
  /* -------------------------------------------------------------------------- */
  
  tracksState.load([
    'completed',
    'inPlaylist',
    'mediaItemsFailed',
    'noMediaItemsFound'
  ])
}
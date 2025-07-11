import { useEventBus } from '@lectorium/mobile/core'
import { useDAL } from '@blocks/app.database'
import { useTracksState } from '@blocks/app.tracks.state'

export function setupTracksStateFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
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
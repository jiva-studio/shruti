import { PlaylistItemsService } from '@lectorium/dal/index'
import { useTrackStateStore } from './useTrackStateStore'

export type Options = {
  playlistItemService: PlaylistItemsService
}

export function useSyncPlaylistStateTask(
  options: Options
) {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const trackStateStore = useTrackStateStore()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  options.playlistItemService.subscribe(async args => {
    if (args.event === 'added') { 
      onAdded({ trackId: args.item.trackId }) 
    }
    if (args.event === 'removed') { 
      onRemoved({ trackId: args.item.trackId }) 
    }
    if (args.event === 'updated' && args.item.completedAt !== undefined) {
      onCompleted({ trackId: args.item.trackId })
    }
    if (args.event === 'updated' && args.item.archivedAt !== undefined) { 
      onRemoved({ trackId: args.item.trackId }) 
    }
  })


  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  function onAdded(
    event: { trackId: string }
  ) {
    trackStateStore.setState(event.trackId, { inPlaylist: true, downloadProgress: 0 })
  }

  function onRemoved(
    event: { trackId: string }
  ) {
    trackStateStore.setState(event.trackId, { 
      inPlaylist: false, 
      isFailed: undefined 
    })
  }

  function onCompleted(
    event: { trackId: string }
  ) {
    trackStateStore.setState(event.trackId, { isCompleted: true })
  }
}
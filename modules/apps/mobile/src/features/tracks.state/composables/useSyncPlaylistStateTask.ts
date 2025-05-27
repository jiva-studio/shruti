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
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function onAdded(
    event: { trackId: string }
  ) {
    trackStateStore.setState(event.trackId, { inPlaylist: true, downloadProgress: 0 })
  }

  async function onRemoved(
    event: { trackId: string }
  ) {
    trackStateStore.setState(event.trackId, { inPlaylist: false })
  }

  function onCompleted(
    event: { trackId: string }
  ) {
    trackStateStore.setState(event.trackId, { isCompleted: true })
  }

  function start() {
    options.playlistItemService.subscribe(async args => {
      if (args.event === 'added') { 
        await onAdded({ trackId: args.item.trackId }) 
      }
      if (args.event === 'removed') { 
        await onRemoved({ trackId: args.item.trackId }) 
      }
      if (args.event === 'updated' && args.item.completedAt !== undefined) {
        onCompleted({ trackId: args.item.trackId })
      }
      if (args.event === 'updated' && args.item.archivedAt !== undefined) { 
        await onRemoved({ trackId: args.item.trackId }) 
      }
    })
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { start }
}
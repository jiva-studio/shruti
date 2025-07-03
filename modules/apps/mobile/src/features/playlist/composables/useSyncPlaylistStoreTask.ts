import { PlaylistItemsService } from '@lectorium/dal/index'
import { usePlaylistStore } from './usePlaylistStore'
import { usePlaylistItemMapper } from './usePlaylistItemMapper'

export type Options = {
  playlistItemService: PlaylistItemsService
}

export function useSyncPlaylistStoreTask(options: Options) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const mapper = usePlaylistItemMapper()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function sync(language: string) {
    // Get playlist items from the database
    const dbPlaylistItems = await options.playlistItemService.getMany({
      limit: 25,
      sort: ['addedAt'],
      selector: { 
        type: 'playlistItem', 
        addedAt: { $gte: null },
        archivedAt: { $exists: false },
      },
    })
    
    // Map them to the view model
    const vmPlaylistItems = await Promise.all(
      dbPlaylistItems.map(playlistItem => mapper.map({ 
        playlistItem, 
        language: language 
      }))
    )

    // Update the store with the new data
    usePlaylistStore().setItems(vmPlaylistItems) 
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { sync }
}
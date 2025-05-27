import { Ref, watch } from 'vue'
import { PlaylistItemsService } from '@lectorium/dal/index'
import { usePlaylistStore } from './usePlaylistStore'
import { usePlaylistItemMapper } from './usePlaylistItemMapper'

export type Options = {
  playlistItemService: PlaylistItemsService
  language: Ref<string>
}

export function useSyncPlaylistStoreTask({
  playlistItemService,
  language
}: Options) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const mapper = usePlaylistItemMapper()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function onSync() {
    // Get playlist items from the database
    const dbPlaylistItems = await playlistItemService.getMany({
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
        language: language.value 
      }))
    )

    // Update the store with the new data
    usePlaylistStore().setItems(vmPlaylistItems) 
  }

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(language, async () => { await onSync() })

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function start() {
    playlistItemService.subscribe(async () => { await onSync() })
    await onSync()
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { start }
}
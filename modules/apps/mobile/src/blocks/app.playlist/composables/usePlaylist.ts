import { createSharedComposable } from '@vueuse/core'
import { usePlaylistLoader } from './usePlaylistLoader'
import { InitOptions } from '../models/InitOptions'
import { usePlaylistStore } from './usePlaylistStore'


export const usePlaylist = createSharedComposable(() => {
  let _options: InitOptions | null = null

  /* -------------------------------------------------------------------------- */
  /*                                    Init                                    */
  /* -------------------------------------------------------------------------- */

  function init(options: InitOptions) {
    _options = options
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function load(language: string) {
    if (!_options) { throw new Error('PlaylistFeature not initialized') }
    const result = await usePlaylistLoader(_options).load(language)
    usePlaylistStore().setItems(result)
  }

  async function add(
    trackId: string
  ): Promise<boolean> {
    if (!_options) { throw new Error('PlaylistFeature not initialized') }
    const o = _options

    // Add track to playlist: 
    const existingPlayListItem = await o.playlistItemsRepository
      .getMany({ selector: { trackId, archivedAt: { $exists: false } } })
    if (existingPlayListItem.length >= 1) { return false }

    // Add track to playlist
    await o.playlistItemsRepository.addOne({
      _id: o.idGenerator(),
      trackId: trackId,
      type: 'playlistItem',
      addedAt: Date.now(),
      completedAt: undefined,
      archivedAt: undefined,
    })

    return true
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Intrface                                  */
  /* -------------------------------------------------------------------------- */

  return {
    init, add, load
  }
})
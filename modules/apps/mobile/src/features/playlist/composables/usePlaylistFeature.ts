import { createSharedComposable } from '@vueuse/core'
import { PlaylistItemsService } from '@lectorium/dal/index'
import { useIdGenerator } from '@lectorium/mobile/features/app.core'

export type Options = {
  playlistService: PlaylistItemsService
}

export const usePlaylistFeature = createSharedComposable(() => {
  let _options: Options|undefined = undefined

  /* -------------------------------------------------------------------------- */
  /*                                    Init                                    */
  /* -------------------------------------------------------------------------- */

  function init(options: Options) {
    _options = options
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function addTrackToPlaylist(
    trackId: string
  ): Promise<boolean> {
    if (!_options) { throw new Error('PlaylistFeature not initialized') }
    const o = _options

    // Add track to playlist: 
    const existingPlayListItem = await o.playlistService
      .getMany({ selector: { trackId, archivedAt: { $exists: false } } })
    if (existingPlayListItem.length >= 1) { return false }

    // Add track to playlist
    await o.playlistService.addOne({
      _id: useIdGenerator().generateId(24),
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
    init, addTrackToPlaylist
  }
})
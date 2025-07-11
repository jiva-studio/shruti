import { InitOptions } from '../models/InitOptions'
import { createSharedComposable } from '@vueuse/core'

export const useSyncMedia = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: InitOptions | null = null

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  async function init(o: InitOptions) { options = o }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function checkTracksWithoutMedia() {
    if (!options) {
      throw new Error('useSyncMedia is not initialized. Call init(options) first.')
    }

    const result = []

    const playlistItems = (await options.playlistItemsRepository.getMany({ 
      selector: { archivedAt: { $exists: false } },
      limit: 1000 // TODO: paginate
    })).sort((a, b) => a.addedAt - b.addedAt)

    // check media items for playlist items
    for (const item of playlistItems) {
      const mediaItem = await options.mediaItemsRepository.getMany({
        selector: { trackId: item.trackId }
      })

      // if no media item found, request download
      if (mediaItem.length <= 0) {
        result.push(item.trackId)
      }
    }

    return { newTrackIds: result }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, checkTracksWithoutMedia }
})
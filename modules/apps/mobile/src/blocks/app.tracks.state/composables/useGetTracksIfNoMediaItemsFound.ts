import { MediaItem } from '@lectorium/dal/models'
import { InitOptions } from '../models/InitOptions'

export function useGetTracksIfNoMediaItemsFound(
  options: InitOptions
) {
  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function get() {
    const failedStates: MediaItem['state'][] = ['pending', 'failed']
    const result = []
    
    const activePlaylistItems = await options.playlistItemsRepository.getMany({ 
      selector: { archivedAt: { $exists: false } },
      limit: 1000, // TODO: Remove limit when pagination is implemented
    })

    // Check all playlist items and set the download failed status
    // to true for each track that has no media items or has media items
    // in the failed state
    const allRelatedMediaItems = await options.mediaItemsRepository.getMany({ 
      selector: { trackId: { $in: activePlaylistItems.map(x => x.trackId) } },
      limit: 1000, // TODO: Remove limit when pagination is implemented
    })

    for (const playlistItem of activePlaylistItems) {
      const relatedMediaItems = allRelatedMediaItems.filter(
        x => x.trackId === playlistItem.trackId
      )
      const mediaItemsEmpty = relatedMediaItems.length === 0
      const mediaItemsFailed = relatedMediaItems.some(
        x => failedStates.includes(x.state)
      )

      if (mediaItemsEmpty || mediaItemsFailed) {
        result.push(playlistItem.trackId)
      }
    }

    return result
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { get }
}
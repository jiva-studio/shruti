import { Track } from '@shruti/dal/models'
import { InitOptions } from '../models/InitOptions'
import { PlaylistStoreItem } from '../models/PlaylistStoreItem'
import { usePlaylistItemMapper } from './usePlaylistItemMapper'


export function usePlaylistLoader(options: InitOptions) {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const mapper = usePlaylistItemMapper()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function load(
    language: string
  ) : Promise<PlaylistStoreItem[]> {
    
    // Get playlist items from the database
    const dbPlaylistItems = await options.playlistItemsRepository.getMany({
      limit: 25,
      sort: ['addedAt'],
      selector: { 
        type: 'playlistItem', 
        addedAt: { $gte: null },
        archivedAt: { $exists: false },
      },
    })

    // Get all related tracks in one query to avoid N+1 query problem
    const tracks = await options.tracksRepository.getMany({
      selector: { _id: { $in: dbPlaylistItems.map(item => item.trackId) } },
      limit: 1000, // TODO: Remove limit when pagination is implemented
    })
    
    // Map playlist items to the view model
    const vmPlaylistItems = await Promise.all(
      dbPlaylistItems.map(playlistItem => mapper.map({ 
        playlistItem, 
        track: tracks.find(track => track._id === playlistItem.trackId) as Track,
        language: language 
      }))
    )

    return vmPlaylistItems
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { load }
}
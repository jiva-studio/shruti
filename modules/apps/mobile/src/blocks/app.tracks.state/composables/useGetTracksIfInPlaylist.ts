import { InitOptions } from '../models/InitOptions'

export function useGetTracksIfInPlaylist(
  options: InitOptions
) {
  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function get() {
    const activePlaylistItems = await options.playlistItemsRepository.getMany({ 
      selector: { archivedAt: { $exists: false } },
      limit: 1000, // TODO: Remove limit when pagination is implemented
    })
    return activePlaylistItems.map(item => item.trackId)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { get }
}
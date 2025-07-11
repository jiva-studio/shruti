import { InitOptions } from '../models/InitOptions'

export function useGetTracksIfCompleted(
  options: InitOptions
) {
  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function get() {
    // Get all tracks that are in the completed state
    const completedPlaylistItems = await options.playlistItemsRepository.getMany({
      selector: {
        completedAt: { $exists: true },
      },
      limit: 1000, // TODO: Remove limit when pagination is implemented
    })
    return completedPlaylistItems.map(item => item.trackId)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { get }
}
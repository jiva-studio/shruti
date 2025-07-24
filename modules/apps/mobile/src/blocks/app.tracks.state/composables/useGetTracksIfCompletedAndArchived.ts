import { InitOptions } from '../models/InitOptions'

export function useGetTracksIfCompletedAndArchived(
  options: InitOptions
) {
  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function get() {
    // Get all tracks that are in the completed state
    const items = await options.playlistItemsRepository.getMany({
      selector: {
        completedAt: { $exists: true },
        archivedAt: { $exists: true },
      },
      limit: 1000, // TODO: Remove limit when pagination is implemented
    })
    return items.map(item => item.trackId)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { get }
}
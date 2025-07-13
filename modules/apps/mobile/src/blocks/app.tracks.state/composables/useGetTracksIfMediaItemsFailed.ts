import { MediaItem } from '@shruti/dal/models'
import { InitOptions } from '../models/InitOptions'

export function useGetTracksIfMediaItemsFailed(
  options: InitOptions
) {
  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function get() {
    const failedStates: MediaItem['state'][] = ['pending', 'failed']
    
    // Get all media items that are in the pending or in failed state
    // and set the download failed status to true for each track
    const failedMediaItems = await options.mediaItemsRepository.getMany({
      selector: { state: { $in: failedStates } },
      limit: 1000, // TODO: Remove limit when pagination is implemented
    })
    return failedMediaItems
      .map(mediaItem => mediaItem.trackId)
      .filter(id => id !== undefined)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { get }
}
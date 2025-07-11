import type { MediaItem } from '../models'
import { MediaItemsRepository } from '../repositories/MediaItemsRepository'

/**
 * Service for managing MediaItems
 */
export class MediaItemsService {
  
  constructor(
    private readonly mediaItemsRepository: MediaItemsRepository
  ) { }

  /**
   * Gets all media items in the specified states.
   * @param states States to filter by
   * @returns List of media items in the specified states
   */
  async getInState(
    states: MediaItem['state'][]
  ): Promise<MediaItem[]> {
    return await this.mediaItemsRepository.getMany({
      selector: {
        state: { $in: states }
      }
    })
  }
}

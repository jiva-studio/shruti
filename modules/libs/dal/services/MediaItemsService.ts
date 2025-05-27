import type { MediaItem } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

/**
 * Schema of the MediaItem documents in the userData collection.
 */
type MediaItemDBSchema = {
  _id: string
  type: "mediaItem"
  remoteUrl: string
  localPath: string
  trackId: string,
  state: 'pending' | 'ready' | 'failed'
}

const mediaItemSerializer = (item: MediaItem): MediaItemDBSchema => item
const mediaItemDeserializer = (document: MediaItemDBSchema): MediaItem => document


/**
 * Service for managing MediaItems
 */
export class MediaItemsService 
  extends DatabaseService<
    MediaItem, 
    MediaItemDBSchema
  > {
  
  /**
   * Constructs a new instance of the MediaItemsService class.
   * @param database The database instance to be used for data operations.
   */
  constructor(
    database: Database
  ) {
    super(
      database, 
      mediaItemSerializer, 
      mediaItemDeserializer, 
      { type: "mediaItem" }
    )
  }

  /**
   * Gets all media items in the specified states.
   * @param states States to filter by
   * @returns List of media items in the specified states
   */
  async getInState(
    states: MediaItem['state'][]
  ): Promise<MediaItem[]> {
    return await this.getMany({
      selector: {
        state: { $in: states }
      }
    })
  }
}

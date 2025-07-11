import type { MediaItem } from '../models'
import { Database } from '../persistence'
import { PouchRepository } from './PouchRepository'

/**
 * Schema of the MediaItem documents in the userData collection.
 */
export type MediaItemDBSchema = {
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
export class MediaItemsRepository 
  extends PouchRepository<
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
}

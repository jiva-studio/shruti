import { type PlaylistItem } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

/**
 * Schema of the Location documents in the Dictionary collection.
 */
type PlaylistItemDBSchema = {
  _id: string
  type: "playlistItem"
  trackId: string
  addedAt: number
  completedAt: number | undefined
  archivedAt: number | undefined
}

const playlistItemSerializer   = (item: PlaylistItem): PlaylistItemDBSchema => item
const playlistItemDeserializer = (document: PlaylistItemDBSchema): PlaylistItem => document


export class PlaylistItemsService extends DatabaseService<
  PlaylistItem,
  PlaylistItemDBSchema
> {
  constructor(database: Database) {
    super(
      database,
      playlistItemSerializer,
      playlistItemDeserializer, { type: "playlistItem" },
    )
  }

  /**
   * Archives a playlist item by setting its archivedAt 
   * property to the current timestamp.
   * @param id The ID of the playlist item to archive. 
   */
  async archiveOne(id: string): Promise<void> {
    await this.patchOne(id, { archivedAt: Date.now() })
  }
}

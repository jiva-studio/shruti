import { type PlaylistItem } from '../models'
import { Database } from '../persistence'
import { PouchRepository } from './PouchRepository'

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


export class PlaylistItemsRepository extends PouchRepository<
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
}

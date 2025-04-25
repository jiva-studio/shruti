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
  order: number
  played: number
  completedAt: number | undefined
}

const playlistItemSerializer   = (item: PlaylistItem): PlaylistItemDBSchema => item
const playlistItemDeserializer = (document: PlaylistItemDBSchema): PlaylistItem => document


export class PlaylistItemsService extends DatabaseService<
  PlaylistItem,
  PlaylistItemDBSchema
> {
  constructor(database: Database) {
    super(database, playlistItemSerializer, playlistItemDeserializer, { type: "playlistItem" })
  }
}

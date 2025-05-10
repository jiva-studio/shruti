import { type Tag } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

/**
 * Schema of the Tag documents in the Dictionary collection.
 */
type TagsDBSchema = {
  _id: string
  type: "tag",
  version: number,
  fullName: Record<string, string>
}

const tagSerializer   = (item: Tag): TagsDBSchema => item
const tagDeserializer = (document: TagsDBSchema): Tag => document


export class TagsService extends DatabaseService<
  Tag,
  TagsDBSchema
> {
  constructor(database: Database) {
    super(
      database,
      tagSerializer,
      tagDeserializer,
      { type: "tag" },
    )
  }
}

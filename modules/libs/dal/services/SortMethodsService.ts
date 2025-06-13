import type { SortMethod } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

/**
 * Schema of the SortMethod documents in the Library collection.
 */
type SortMethodDBSchema = {
  _id: string
  type: "sort"
  version: number
  fullName: Record<string, string>
}

const sortMethodSerializer = (item: SortMethod): SortMethodDBSchema => item
const sortMethodDeserializer = (document: SortMethodDBSchema): SortMethod => document


/**
 * Service for managing Sources
 */
export class SortMethodsService extends DatabaseService<SortMethod, SortMethodDBSchema> {
  constructor(database: Database) {
    super(database, sortMethodSerializer, sortMethodDeserializer, { type: "sort" })
  }
}

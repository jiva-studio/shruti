import type { SortMethod } from '../models'
import { Database } from '../persistence'
import { PouchRepository } from './PouchRepository'

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


export class SortMethodsRepository extends PouchRepository<SortMethod, SortMethodDBSchema> {
  constructor(database: Database) {
    super(database, sortMethodSerializer, sortMethodDeserializer, { type: "sort" })
  }
}

import type { Source } from '../models'
import { Database } from '../persistence'
import { PouchRepository } from './PouchRepository'

/**
 * Schema of the Source documents in the Library collection.
 */
type SourcesDBSchema = {
  _id: string
  type: "source"
  version: number
  shortName: Record<string, string>
  fullName: Record<string, string>
}

const sourceSerializer = (item: Source): SourcesDBSchema => item
const sourceDeserializer = (document: SourcesDBSchema): Source => document


/**
 * Service for managing Sources
 */
export class SourcesRepository extends PouchRepository<Source, SourcesDBSchema> {
  constructor(database: Database) {
    super(database, sourceSerializer, sourceDeserializer, { type: "source" })
  }
}

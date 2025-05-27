import type { Duration } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

/**
 * Schema of the Duration documents in the Library collection.
 */
type DurationsDBSchema = {
  _id: string
  type: "duration"
  version: number
  fullName: Record<string, string>
  minDuration: number
  maxDuration: number
}

const sourceSerializer = (item: Duration): DurationsDBSchema => item
const sourceDeserializer = (document: DurationsDBSchema): Duration => document


/**
 * Service for managing Sources
 */
export class DurationsService extends DatabaseService<Duration, DurationsDBSchema> {
  constructor(database: Database) {
    super(database, sourceSerializer, sourceDeserializer, { type: "duration" })
  }
}

import { type Location } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

/**
 * Schema of the Source documents in the Library collection.
 */
type LocationsDBSchema = {
  _id: string
  name: {
    [language: string]: string
  }
}

const locationSerializer   = (item: Location): LocationsDBSchema => item
const locationDeserializer = (document: LocationsDBSchema): Location => document


export class LocationsService extends DatabaseService<
  Location,
  LocationsDBSchema
> {
  constructor(database: Database) {
    super(database, locationSerializer, locationDeserializer, { type: "location" })
  }
}

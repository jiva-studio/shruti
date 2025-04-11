import { type Language } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

/**
 * Schema of the Location documents in the Dictionary collection.
 */
type LanguageDBSchema = {
  _id: string
  type: "language",
  version: number,
  code: string,
  fullName: string,
  icon: string,
}

const locationSerializer   = (item: Language): LanguageDBSchema => item
const locationDeserializer = (document: LanguageDBSchema): Language => document


export class LanguagesService extends DatabaseService<
  Language,
  LanguageDBSchema
> {
  constructor(database: Database) {
    super(database, locationSerializer, locationDeserializer, { type: "language" })
  }
}

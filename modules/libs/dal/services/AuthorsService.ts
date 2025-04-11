import type { Author } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

export type AuthorDbScheme = {
  _id: string
  type: "author"
  version: number
  fullName: Record<string, string>
}

const authorSerializer   = (item: Author): AuthorDbScheme => item
const authorDeserializer = (document: AuthorDbScheme): Author => document

export class AuthorsService extends DatabaseService<Author, AuthorDbScheme> {
  constructor(database: Database) {
    super(
      database,
      authorSerializer,
      authorDeserializer, 
      { type: "author" })
  }
}

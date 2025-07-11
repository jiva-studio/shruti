import type { Author } from '../models'
import { Database } from '../persistence'
import { PouchRepository } from './PouchRepository'

export type AuthorDbScheme = {
  _id: string
  type: "author"
  version: number
  fullName: Record<string, string>
}

const authorSerializer   = (item: Author): AuthorDbScheme => item
const authorDeserializer = (document: AuthorDbScheme): Author => document

export class AuthorsRepository extends PouchRepository<Author, AuthorDbScheme> {
  constructor(database: Database) {
    super(
      database,
      authorSerializer,
      authorDeserializer, 
      { type: "author" }
    )
  }
}

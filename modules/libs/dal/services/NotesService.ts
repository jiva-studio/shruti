import type { Note } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

export type NoteDbScheme = {
  _id: string
  type: 'note'
  trackId: string
  text: string
  blocks: string[]
  createdAt: number
}

const noteSerializer   = (item: Note): NoteDbScheme => item
const noteDeserializer = (document: NoteDbScheme): Note => document

export class NotesService extends DatabaseService<Note, NoteDbScheme> {
  constructor(database: Database) {
    super(
      database,
      noteSerializer,
      noteDeserializer, 
      { type: "note" }
    )
  }
}

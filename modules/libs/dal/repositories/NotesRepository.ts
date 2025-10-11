import type { Note } from '../models'
import { Database } from '../persistence'
import { PouchRepository } from './PouchRepository'

export type NoteDbScheme = {
  _id: string
  type: 'note'
  trackId: string
  text: string
  timeStart: number
  timeEnd: number
  createdAt: number
}

const noteSerializer   = (item: Note): NoteDbScheme => item
const noteDeserializer = (document: NoteDbScheme): Note => document

export class NotesRepository extends PouchRepository<Note, NoteDbScheme> {
  constructor(database: Database) {
    super(
      database,
      noteSerializer,
      noteDeserializer, 
      { type: { $in: [ "note" ] } }
    )
  }
}

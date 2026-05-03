import type { NoteId, TrackId } from "../core.js"
import type { Note } from "../note.js"

export interface CreateNoteInput {
  readonly trackId: TrackId
  readonly text: string
  readonly timeStart: number
  readonly timeEnd: number
}

export interface UpdateNoteInput {
  readonly id: NoteId
  readonly text?: string
  readonly timeStart?: number
  readonly timeEnd?: number
}

export interface INoteRepository {
  getById(id: NoteId): Promise<Note | null>
  listByTrack(trackId: TrackId): Promise<readonly Note[]>
  listRecent(limit: number): Promise<readonly Note[]>
  create(input: CreateNoteInput): Promise<Note>
  update(input: UpdateNoteInput): Promise<Note>
  delete(id: NoteId): Promise<void>
  clearAll(): Promise<void>
}

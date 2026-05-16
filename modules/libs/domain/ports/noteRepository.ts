import type { NoteId, TrackId } from "../core.js"
import type { Note, NoteMeta } from "../note.js"

export interface CreateNoteInput {
  readonly trackId: TrackId
  readonly text: string
  readonly timeStart: number
  readonly timeEnd: number
  readonly meta?: NoteMeta | null
}

export interface UpdateNoteInput {
  readonly id: NoteId
  readonly text?: string
  readonly timeStart?: number
  readonly timeEnd?: number
  /**
   * `undefined` leaves the column untouched. `null` clears it. A non-null
   * object **replaces** the row's meta wholesale — there's no shallow
   * merge here on purpose; callers that want to patch a single slot
   * should read-merge-write themselves so the merge policy stays in the
   * caller and not buried in the repo.
   */
  readonly meta?: NoteMeta | null
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

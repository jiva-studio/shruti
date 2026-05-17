import type { NoteId, TrackId } from "../core.js"
import type { Note, NoteMeta } from "../note.js"

export interface CreateNoteInput {
  readonly trackId: TrackId
  readonly text: string
  readonly timeStart: number
  readonly timeEnd: number
  readonly meta?: NoteMeta | null
  /**
   * Optional caller-supplied id. When set, the repository becomes
   * idempotent: if a note with this id already exists it's returned
   * unchanged; only on first call does a fresh row land. Used by the
   * chat store so a flaky-network re-tap on "save as note" doesn't
   * duplicate the entry — the chat action id deterministically maps to
   * a stable note id.
   */
  readonly id?: NoteId
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

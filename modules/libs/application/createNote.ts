import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export interface CreateNoteInput {
  readonly trackId: TrackId
  readonly text: string
  /** milliseconds — see `Note.timeStart` */
  readonly timeStart: number
  /** milliseconds — see `Note.timeEnd` */
  readonly timeEnd: number
  /** Optional deterministic id. When supplied, the repo becomes
   *  idempotent: re-runs return the existing note instead of inserting
   *  a duplicate. Chat callers derive it from action.id so a flaky-
   *  network re-tap on "save as note" doesn't double-save. */
  readonly id?: NoteId
}

export type CreateNoteError =
  | "empty-text"
  | "text-too-long"
  | "invalid-timestamps"

const MAX_NOTE_LENGTH = 4000

export interface CreateNoteDeps {
  readonly notes: INoteRepository
}

export async function createNote(
  input: CreateNoteInput,
  deps: CreateNoteDeps
): Promise<Result<Note, CreateNoteError>> {
  const text = input.text.trim()
  if (!text) return err("empty-text")
  if (text.length > MAX_NOTE_LENGTH) return err("text-too-long")
  if (
    !Number.isFinite(input.timeStart) ||
    !Number.isFinite(input.timeEnd) ||
    input.timeStart < 0 ||
    input.timeEnd < input.timeStart
  ) {
    return err("invalid-timestamps")
  }
  const note = await deps.notes.create({
    trackId: input.trackId,
    text,
    timeStart: input.timeStart,
    timeEnd: input.timeEnd,
    id: input.id,
  })
  return ok(note)
}

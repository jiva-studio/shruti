import type { NoteId, TrackId } from "@lib/domain/core.js"
import { validateNoteFields, type Note } from "@lib/domain/note.js"
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

export type CreateNoteError = "empty-text" | "text-too-long" | "invalid-timestamps"

export interface CreateNoteDeps {
  readonly notes: INoteRepository
}

export async function createNote(
  input: CreateNoteInput,
  deps: CreateNoteDeps
): Promise<Result<Note, CreateNoteError>> {
  const validated = validateNoteFields({
    text: input.text,
    timeStart: input.timeStart,
    timeEnd: input.timeEnd,
  })
  if (!validated.ok) {
    // Domain returns fine-grained tags (invalid-time / invalid-range);
    // createNote's contract still folds both into a single umbrella so
    // existing UI callers don't have to branch on a new case.
    if (validated.error === "empty-text") return err("empty-text")
    if (validated.error === "text-too-long") return err("text-too-long")
    return err("invalid-timestamps")
  }
  const note = await deps.notes.create({
    trackId: input.trackId,
    text: validated.value.text,
    timeStart: validated.value.timeStart,
    timeEnd: validated.value.timeEnd,
    id: input.id,
  })
  return ok(note)
}

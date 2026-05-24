import type { NoteId } from "@lib/domain/core.js"
import { validateNoteFields, type Note, type NoteMeta } from "@lib/domain/note.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export interface UpdateNoteInput {
  readonly id: NoteId
  readonly text?: string
  readonly timeStart?: number
  readonly timeEnd?: number
  /** `undefined` = don't touch, `null` = clear, object = replace wholesale. */
  readonly meta?: NoteMeta | null
}

export type UpdateNoteError =
  | "not-found"
  | "empty-text"
  | "text-too-long"
  | "invalid-range"
  | "invalid-time"

export interface UpdateNoteDeps {
  readonly notes: INoteRepository
  readonly unitOfWork: IUnitOfWork
}

/**
 * Update fields on an existing note. Partial — only provided fields are
 * written. Validates the *merged* (existing + patch) field set against
 * the same `validateNoteFields` invariants as `createNote`, so a
 * partial update can't sneak past a constraint the original insert
 * would have rejected (length cap, negative start, inverted range,
 * NaN/Infinity).
 */
export async function updateNote(
  input: UpdateNoteInput,
  deps: UpdateNoteDeps
): Promise<Result<Note, UpdateNoteError>> {
  return deps.unitOfWork.run(async () => {
    const existing = await deps.notes.getById(input.id)
    if (!existing) return err("not-found")
    const merged = {
      text: input.text ?? existing.text,
      timeStart: input.timeStart ?? existing.timeStart,
      timeEnd: input.timeEnd ?? existing.timeEnd,
    }
    const validated = validateNoteFields(merged)
    if (!validated.ok) return err(validated.error)
    const updated = await deps.notes.update({
      id: input.id,
      // Patch payload still uses the per-field "undefined means don't
      // touch" convention, but the *text* slot writes the trimmed value
      // when supplied — otherwise the column would drift between the
      // domain (always trimmed) and a sloppy caller (untrimmed update).
      text: input.text !== undefined ? validated.value.text : undefined,
      timeStart: input.timeStart,
      timeEnd: input.timeEnd,
      meta: input.meta,
    })
    return ok(updated)
  })
}

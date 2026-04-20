import type { NoteId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export interface UpdateNoteInput {
  readonly id: NoteId
  readonly text?: string
  readonly timeStart?: number
  readonly timeEnd?: number
}

export type UpdateNoteError = "not-found" | "empty-text" | "invalid-range"

export interface UpdateNoteDeps {
  readonly notes: INoteRepository
  readonly unitOfWork: IUnitOfWork
}

/**
 * Update fields on an existing note. Partial — only provided fields are
 * written. Guards against empty text and inverted time ranges so the
 * repository never sees malformed input.
 */
export async function updateNote(
  input: UpdateNoteInput,
  deps: UpdateNoteDeps
): Promise<Result<Note, UpdateNoteError>> {
  if (input.text !== undefined && input.text.trim().length === 0) {
    return err("empty-text")
  }
  if (
    input.timeStart !== undefined &&
    input.timeEnd !== undefined &&
    input.timeEnd < input.timeStart
  ) {
    return err("invalid-range")
  }
  return deps.unitOfWork.run(async () => {
    const existing = await deps.notes.getById(input.id)
    if (!existing) return err("not-found")
    const updated = await deps.notes.update({
      id: input.id,
      text: input.text,
      timeStart: input.timeStart,
      timeEnd: input.timeEnd,
    })
    return ok(updated)
  })
}

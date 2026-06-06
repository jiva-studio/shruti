import type { NoteId } from "@lib/domain/core.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { err, ok, type Result } from "@kit/core"

export interface DeleteNoteInput {
  readonly id: NoteId
}

export type DeleteNoteError = "not-found"

export interface DeleteNoteDeps {
  readonly notes: INoteRepository
  readonly unitOfWork: IUnitOfWork
}

/**
 * Delete a user note by id. Returns `not-found` for missing notes so the
 * caller can distinguish "nothing to do" from "actually deleted".
 */
export async function deleteNote(
  input: DeleteNoteInput,
  deps: DeleteNoteDeps
): Promise<Result<void, DeleteNoteError>> {
  return deps.unitOfWork.run(async () => {
    const existing = await deps.notes.getById(input.id)
    if (!existing) return err("not-found")
    await deps.notes.delete(input.id)
    return ok(undefined)
  })
}

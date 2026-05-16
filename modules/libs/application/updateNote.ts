import type { NoteId } from "@lib/domain/core.js"
import type { Note, NoteMeta } from "@lib/domain/note.js"
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

export type UpdateNoteError = "not-found" | "empty-text" | "invalid-range" | "invalid-time"

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
  // NaN/±Infinity pass through `<`/`<=` comparisons as false, so the
  // range guard below would silently accept garbage. Reject explicitly
  // — mirrors the Number.isFinite check in createNote.
  if (input.timeStart !== undefined && !Number.isFinite(input.timeStart)) {
    return err("invalid-time")
  }
  if (input.timeEnd !== undefined && !Number.isFinite(input.timeEnd)) {
    return err("invalid-time")
  }
  return deps.unitOfWork.run(async () => {
    const existing = await deps.notes.getById(input.id)
    if (!existing) return err("not-found")
    // Validate the *merged* range, not just the input pair. A partial
    // update like { timeStart: 150 } against an existing { 0, 100 }
    // would otherwise persist start > end and break note rendering.
    const mergedStart = input.timeStart ?? existing.timeStart
    const mergedEnd = input.timeEnd ?? existing.timeEnd
    if (mergedEnd < mergedStart) return err("invalid-range")
    const updated = await deps.notes.update({
      id: input.id,
      text: input.text,
      timeStart: input.timeStart,
      timeEnd: input.timeEnd,
      meta: input.meta,
    })
    return ok(updated)
  })
}

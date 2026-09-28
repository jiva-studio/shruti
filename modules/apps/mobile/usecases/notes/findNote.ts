import type { NoteId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"

/** One note by id, or `null` when it was deleted. */
export function findNote(
  id: NoteId,
  deps: { readonly notes: INoteRepository }
): Promise<Note | null> {
  return deps.notes.getById(id)
}

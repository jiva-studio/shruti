import type { Result } from "@kit/core"
import type { NoteId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import { deleteNote, type DeleteNoteError } from "@usecases/notes/deleteNote.js"
import { findNote } from "@usecases/notes/findNote.js"
import { loadNoteCorpus } from "@usecases/notes/searchNotes.js"
import {
  updateNote,
  type UpdateNoteError,
  type UpdateNoteInput,
} from "@usecases/notes/updateNote.js"
import { useShruti } from "@shruti/shruti.js"

export interface NoteUseCases {
  loadCorpus(): Promise<readonly Note[]>
  find(id: NoteId): Promise<Note | null>
  remove(id: NoteId): Promise<Result<void, DeleteNoteError>>
  update(input: UpdateNoteInput): Promise<Result<Note, UpdateNoteError>>
}

/** The note use cases, bound to the repositories, which are resolved per call
 *  and so throw until the databases are open. */
export function useNoteUseCases(): NoteUseCases {
  const app = useShruti()
  return {
    loadCorpus: () => loadNoteCorpus(app.repositories()),
    find: (id) => findNote(id, app.repositories()),
    remove: (id) => deleteNote({ id }, app.repositories()),
    update: (input) => updateNote(input, app.repositories()),
  }
}

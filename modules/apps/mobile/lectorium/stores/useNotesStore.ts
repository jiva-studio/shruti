import { defineStore } from "pinia"
import { ref } from "vue"
import { deleteNote, type DeleteNoteError } from "@lib/application/deleteNote.js"
import { searchNotes } from "@lib/application/searchNotes.js"
import { updateNote, type UpdateNoteError } from "@lib/application/updateNote.js"
import type { NoteId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { Result } from "@lib/domain/result.js"
import { useLectorium } from "@lectorium/lectorium.js"

/**
 * Reactive cache of notes. NotesView reads `filtered` and `isLoading`;
 * the bookmark flow, deletions, and refresh all go through the store so
 * the list re-renders without NotesView owning its own fetch logic.
 */
export const useNotesStore = defineStore("notes", () => {
  const app = useLectorium()

  const all = ref<readonly Note[]>([])
  const filtered = ref<readonly Note[]>([])
  const query = ref<string>("")
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)

  async function refresh(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      all.value = await app.repositories().notes.listRecent(500)
      await applyFilter()
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load notes"
      all.value = []
      filtered.value = []
    } finally {
      isLoading.value = false
    }
  }

  async function applyFilter(): Promise<void> {
    filtered.value = await searchNotes(
      { query: query.value },
      { notes: app.repositories().notes }
    )
  }

  async function setQuery(next: string): Promise<void> {
    query.value = next
    await applyFilter()
  }

  async function remove(id: NoteId): Promise<Result<void, DeleteNoteError>> {
    const repos = app.repositories()
    const result = await deleteNote(
      { id },
      { notes: repos.notes, unitOfWork: repos.unitOfWork }
    )
    if (result.ok) await refresh()
    return result
  }

  async function update(
    input: { id: NoteId; text?: string; timeStart?: number; timeEnd?: number }
  ): Promise<Result<Note, UpdateNoteError>> {
    const repos = app.repositories()
    const result = await updateNote(input, { notes: repos.notes, unitOfWork: repos.unitOfWork })
    if (result.ok) await refresh()
    return result
  }

  return { all, filtered, query, isLoading, error, refresh, setQuery, remove, update }
})

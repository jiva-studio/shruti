import { defineStore } from "pinia"
import { ref } from "vue"
import { useDebounceFn } from "@vueuse/core"
import { deleteNote, type DeleteNoteError } from "@usecases/notes/deleteNote.js"
import { filterNotes, SEARCH_CORPUS_CAP } from "@usecases/notes/searchNotes.js"
import { updateNote, type UpdateNoteError } from "@usecases/notes/updateNote.js"
import type { NoteId } from "@lib/domain/core.js"
import type { Note, NoteMeta } from "@lib/domain/note.js"
import type { Result } from "@kit/core"
import { useLectorium } from "@lectorium/lectorium.js"
import { requestSync } from "@lectorium/services/syncEvents.js"

/**
 * Keystroke debounce for the notes search field. Same 200 ms the track
 * search lane uses (`useSearchQuery`), so both fields feel identical.
 */
const SEARCH_DEBOUNCE_MS = 200

/**
 * Reactive cache of notes. NotesView reads `filtered` and `isLoading`;
 * the bookmark flow, deletions, and refresh all go through the store so
 * the list re-renders without NotesView owning its own fetch logic.
 *
 * `all` holds the searchable corpus, loaded once per `refresh()`. Search
 * then filters that in memory instead of re-reading SQLite per keystroke.
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
      all.value = await app.repositories().notes.listRecent(SEARCH_CORPUS_CAP)
      applyFilter()
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load notes"
      all.value = []
      filtered.value = []
    } finally {
      isLoading.value = false
    }
  }

  function applyFilter(): void {
    filtered.value = filterNotes(all.value, query.value)
  }

  // Reads `query` at fire time, never at schedule time, so a timer left over
  // from an earlier keystroke recomputes against the latest text — no stale
  // result can land on top of a newer one, and no cancellation is needed.
  const applyFilterDebounced = useDebounceFn(applyFilter, SEARCH_DEBOUNCE_MS)

  async function setQuery(next: string): Promise<void> {
    query.value = next
    // Clearing the field snaps back to the full list immediately — waiting
    // 200 ms to show notes the user already had is the one delay that reads
    // as a bug rather than as typing.
    if (!next.trim()) {
      applyFilter()
      return
    }
    await applyFilterDebounced()
  }

  async function remove(id: NoteId): Promise<Result<void, DeleteNoteError>> {
    const repos = app.repositories()
    const result = await deleteNote({ id }, { notes: repos.notes, unitOfWork: repos.unitOfWork })
    if (result.ok) {
      requestSync()
      await refresh()
    }
    return result
  }

  async function update(input: {
    id: NoteId
    text?: string
    timeStart?: number
    timeEnd?: number
    meta?: NoteMeta | null
  }): Promise<Result<Note, UpdateNoteError>> {
    const repos = app.repositories()
    const result = await updateNote(input, { notes: repos.notes, unitOfWork: repos.unitOfWork })
    if (result.ok) {
      requestSync()
      await refresh()
    }
    return result
  }

  return { all, filtered, query, isLoading, error, refresh, setQuery, remove, update }
})

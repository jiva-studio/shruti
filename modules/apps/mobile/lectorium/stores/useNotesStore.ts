import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { useDebounceFn } from "@vueuse/core"
import { deleteNote, type DeleteNoteError } from "@usecases/notes/deleteNote.js"
import {
  DEFAULT_SEARCH_LIMIT,
  searchNotes,
  SEARCH_CORPUS_CAP,
} from "@usecases/notes/searchNotes.js"
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
 * Rows handed to the list per page. Same shape as `usePlaylistStore`: the
 * store keeps the whole result set and the view pages through it with an
 * `IonInfiniteScroll`, because every rendered row mounts an `<audio>` element
 * and an `IntersectionObserver` and the corpus goes up to `SEARCH_CORPUS_CAP`.
 */
const PAGE_SIZE = 50

/**
 * Reactive cache of notes. NotesView reads `rendered` and `isLoading`;
 * the bookmark flow, deletions, and refresh all go through the store so
 * the list re-renders without NotesView owning its own fetch logic.
 *
 * `all` holds the searchable corpus, loaded once per `refresh()`. Search
 * then filters that in memory instead of re-reading SQLite per keystroke.
 *
 * Three lists, narrowing left to right: `all` (the corpus) → `filtered`
 * (what the current query matched) → `rendered` (the window the list has
 * paged in so far). Anything that has to see every match — "nothing found",
 * `hasMore` — reads `filtered`; only the `v-for` reads `rendered`.
 */
export const useNotesStore = defineStore("notes", () => {
  const app = useLectorium()

  const all = ref<readonly Note[]>([])
  const filtered = ref<readonly Note[]>([])
  const rendered = ref<readonly Note[]>([])
  const query = ref<string>("")
  /**
   * The query `filtered` was actually computed from. Lags `query` by the
   * debounce. Anything describing the CURRENT results — search highlighting,
   * "nothing found" copy — must read this, or it renders the new query
   * against the old result set for 200 ms.
   */
  const appliedQuery = ref<string>("")
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  /**
   * The search hit the result cap and more notes matched past it. The list
   * cannot page to them (the scan stopped there on purpose), so the view says
   * so instead of ending at 200 rows as if that were the whole answer.
   */
  const searchTruncated = ref<boolean>(false)

  const hasMore = computed<boolean>(() => rendered.value.length < filtered.value.length)

  async function refresh(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      all.value = await app.repositories().notes.listRecent(SEARCH_CORPUS_CAP)
      // Keep the window the user has already scrolled open: a refresh fires on
      // every tab entry and after each delete, and re-collapsing to page 1
      // would throw away their scroll position.
      applyFilter()
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load notes"
      all.value = []
      filtered.value = []
      rendered.value = []
      searchTruncated.value = false
    } finally {
      isLoading.value = false
    }
  }

  function applyFilter(resetWindow = false): void {
    appliedQuery.value = query.value
    // Browsing (blank query) is NOT capped — the list pages through it.
    // A query still caps at `searchNotes`' default limit: the scan breaks out
    // there, which is what keeps a one-letter query from building a
    // 100 000-element array on every keystroke. When it does cap, the view is
    // told, so the truncation is stated rather than mimed as an ending list.
    if (query.value.trim()) {
      const result = searchNotes(all.value, query.value)
      filtered.value = result.matches
      searchTruncated.value = result.truncated
    } else {
      filtered.value = all.value
      searchTruncated.value = false
    }
    const window = resetWindow ? PAGE_SIZE : Math.max(PAGE_SIZE, rendered.value.length)
    rendered.value = filtered.value.slice(0, window)
  }

  /** Page in the next `PAGE_SIZE` rows. Backs the view's infinite scroll. */
  function loadMore(): void {
    if (!hasMore.value) return
    rendered.value = filtered.value.slice(0, rendered.value.length + PAGE_SIZE)
  }

  // Reads `query` at fire time, never at schedule time, so a timer left over
  // from an earlier keystroke recomputes against the latest text — no stale
  // result can land on top of a newer one, and no cancellation is needed.
  // A new query is a new list, so the window resets to page 1 here (unlike
  // `refresh`, which keeps whatever the user has scrolled open).
  const applyFilterDebounced = useDebounceFn(() => applyFilter(true), SEARCH_DEBOUNCE_MS)

  async function setQuery(next: string): Promise<void> {
    query.value = next
    // Clearing the field snaps back to the full list immediately — waiting
    // 200 ms to show notes the user already had is the one delay that reads
    // as a bug rather than as typing.
    if (!next.trim()) {
      applyFilter(true)
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

  return {
    all,
    filtered,
    rendered,
    hasMore,
    query,
    appliedQuery,
    isLoading,
    error,
    searchTruncated,
    searchLimit: DEFAULT_SEARCH_LIMIT,
    refresh,
    loadMore,
    setQuery,
    remove,
    update,
  }
})

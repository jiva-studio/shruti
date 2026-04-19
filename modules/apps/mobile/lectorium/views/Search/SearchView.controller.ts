import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { useIonRouter } from "@ionic/vue"
import { searchTracks } from "@lib/application/searchTracks.js"
import type { Author } from "@lib/domain/author.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { buildTrackRow } from "@lectorium/composables/buildTrackRow.js"
import type { UiTrackRow } from "@ui/features/tracks.list/index.js"

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

export interface SearchControllerOptions {
  /** UI language used to pick variants and resolve dictionary names. */
  preferredLanguage?: string
}

export interface SearchControllerReturn {
  query: Ref<string>
  rows: ComputedRef<readonly UiTrackRow[]>
  isLoading: Ref<boolean>
  error: Ref<string | null>
  emptyMessage: ComputedRef<string>
  onSelect: (trackId: string) => void
}

/* -------------------------------------------------------------------------- */
/*                              Core Dependencies                             */
/* -------------------------------------------------------------------------- */

export function useSearchController(options: SearchControllerOptions = {}): SearchControllerReturn {
  const { preferredLanguage = "en" } = options

  const app = useLectorium()
  const router = useIonRouter()
  const repos = app.repositories()

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const query = ref<string>("")
  const rawResults = ref<readonly UiTrackRow[]>([])
  const authorsById = ref<ReadonlyMap<string, Author>>(new Map())
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)

  // Load authors once — small dictionary, fits in memory.
  void (async () => {
    try {
      const authors = await repos.authors.listAll()
      authorsById.value = new Map(authors.map((a) => [a.id, a]))
    } catch (err) {
      console.error("failed to load authors", err)
    }
  })()

  /* -------------------------------------------------------------------------- */
  /*                                   Search                                   */
  /* -------------------------------------------------------------------------- */

  let searchToken = 0

  async function runSearch(text: string): Promise<void> {
    const token = ++searchToken
    error.value = null
    if (!text.trim()) {
      rawResults.value = []
      isLoading.value = false
      return
    }
    isLoading.value = true
    try {
      const tracks = await searchTracks(
        { query: text, preferredLanguage, limit: 50 },
        { tracks: repos.tracks }
      )
      if (token !== searchToken) return
      rawResults.value = tracks.map((track) =>
        buildTrackRow(track, { preferredLanguage, authorsById: authorsById.value })
      )
    } catch (err) {
      if (token !== searchToken) return
      error.value = err instanceof Error ? err.message : "Search failed"
      rawResults.value = []
    } finally {
      if (token === searchToken) isLoading.value = false
    }
  }

  watch(query, (next) => {
    void runSearch(next)
  })

  /* -------------------------------------------------------------------------- */
  /*                                  UI State                                  */
  /* -------------------------------------------------------------------------- */

  const rows = computed(() => rawResults.value)
  const emptyMessage = computed(() =>
    query.value.trim()
      ? isLoading.value
        ? "Searching…"
        : "No matches."
      : "Type to search by title or reference (e.g. sb 1.8.40)."
  )

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  function onSelect(trackId: string): void {
    router.push(`/tabs/track/${encodeURIComponent(trackId)}`)
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Return                                   */
  /* -------------------------------------------------------------------------- */

  return {
    query,
    rows,
    isLoading,
    error,
    emptyMessage,
    onSelect,
  }
}

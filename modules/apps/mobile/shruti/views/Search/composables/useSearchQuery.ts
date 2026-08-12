import { ref, watch, type Ref } from "vue"
import { useDebounceFn } from "@vueuse/core"
import { searchAndFilterTracks } from "@usecases/discovery/searchAndFilterTracks.js"
import type { Track } from "@lib/domain/track.js"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"

const PAGE_SIZE = 50

export interface UseSearchQueryOptions {
  query: Ref<string>
  filters: Ref<FiltersModel>
  tracks: ITrackRepository
  /** False while another page owns the shared field — what is typed into it
   *  then is somebody else's to search. */
  enabled: Ref<boolean>
}

export interface UseSearchQueryReturn {
  rawTracks: Ref<readonly Track[]>
  isLoading: Ref<boolean>
  error: Ref<string | null>
  hasMore: Ref<boolean>
  /** A page fetch failed and the next one is the user's to ask for. */
  canRetry: Ref<boolean>
  /** Re-runs the query immediately and resets pagination. */
  runQuery: () => Promise<void>
  /** Loads the next page when `hasMore` is true. */
  loadMore: () => Promise<void>
  /** Re-arms pagination after a failed page and fetches it again. */
  retry: () => Promise<void>
}

/**
 * Owns server-side search pagination, the race-guard token, and the
 * single-flight gate that protects the native SQLite plugin from
 * pile-up.
 *
 * The text-input watcher debounces keystrokes (200 ms) so fast typing
 * doesn't spam SQL. Filter mutations should call `runQuery()` directly —
 * they fire once per gesture and don't need debouncing.
 *
 * Single-flight: at most one search SQL roundtrip runs at a time. A
 * `runQuery()` call while one is already in flight just raises a
 * "rerun" flag; the active loop notices it on completion and re-runs
 * once with the latest input. This stops the Capacitor-SQLite plugin
 * from serializing several stale searches behind the current one —
 * the failure mode where typing three letters used to compound into
 * multi-second waits because each keystroke queued its own MATCH and
 * the hydrate calls of the latest search waited behind every prior
 * MATCH in the plugin's queue. `loadMore()` takes the same gate — a page
 * fetch is the same roundtrip — and hands the gate back to a query raised
 * while it was busy.
 *
 * Empty query + no filters falls through to `tracks.list()` (the
 * `searchAndFilterTracks` use case handles the branching) so the initial
 * Search view shows the full catalog (paginated) rather than an empty
 * list.
 */
export function useSearchQuery(options: UseSearchQueryOptions): UseSearchQueryReturn {
  const rawTracks = ref<readonly Track[]>([])
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  const offset = ref<number>(0)
  const hasMore = ref<boolean>(false)
  const canRetry = ref<boolean>(false)
  let searchToken = 0

  async function fetchPage(pageOffset: number): Promise<readonly Track[]> {
    return searchAndFilterTracks(
      {
        query: options.query.value,
        authorIds: options.filters.value.authors,
        languageCodes: options.filters.value.languages,
        locationIds: options.filters.value.locations,
        sourceIds: options.filters.value.sources,
        tagIds: options.filters.value.tags,
        topicIds: options.filters.value.topics,
        durationFilter: options.filters.value.duration as DurationFilterId | undefined,
        dateFrom: options.filters.value.dateFrom,
        dateTo: options.filters.value.dateTo,
        sortBy: options.filters.value.sort as SortMethod | undefined,
        limit: PAGE_SIZE,
        offset: pageOffset,
      },
      { tracks: options.tracks }
    )
  }

  let activeRun: Promise<void> | null = null
  let rerunPending = false

  async function runFirstPage(): Promise<void> {
    const token = ++searchToken
    error.value = null
    canRetry.value = false
    offset.value = 0
    hasMore.value = false
    isLoading.value = true
    try {
      const tracks = await fetchPage(0)
      if (token !== searchToken) return
      rawTracks.value = tracks
      hasMore.value = tracks.length >= PAGE_SIZE
      offset.value = PAGE_SIZE
    } catch (err) {
      if (token !== searchToken) return
      error.value = err instanceof Error ? err.message : "Search failed"
      rawTracks.value = []
    } finally {
      if (token === searchToken) isLoading.value = false
    }
  }

  async function runNextPage(): Promise<void> {
    const token = searchToken
    const pageOffset = offset.value
    error.value = null
    canRetry.value = false
    isLoading.value = true
    try {
      const tracks = await fetchPage(pageOffset)
      if (token !== searchToken) return
      rawTracks.value = [...rawTracks.value, ...tracks]
      hasMore.value = tracks.length >= PAGE_SIZE
      offset.value = pageOffset + PAGE_SIZE
    } catch (err) {
      if (token !== searchToken) return
      error.value = err instanceof Error ? err.message : "Search failed"
      // Disarm infinite scroll — an armed `hasMore` on a failed page means the
      // next scroll retries the same offset, forever — but hand the page to
      // the user instead of ending the list: `canRetry` puts a button under it.
      hasMore.value = false
      canRetry.value = true
    } finally {
      if (token === searchToken) isLoading.value = false
    }
  }

  /** Drain a `runQuery()` raised while this run held the gate. */
  async function drainReruns(): Promise<void> {
    while (rerunPending) {
      rerunPending = false
      await runFirstPage()
    }
  }

  async function runQuery(): Promise<void> {
    if (activeRun) {
      rerunPending = true
      return activeRun
    }
    activeRun = (async () => {
      try {
        rerunPending = false
        await runFirstPage()
        await drainReruns()
      } finally {
        activeRun = null
      }
    })()
    return activeRun
  }

  function fetchNextPage(): Promise<void> {
    activeRun = (async () => {
      try {
        await runNextPage()
        await drainReruns()
      } finally {
        activeRun = null
      }
    })()
    return activeRun
  }

  async function loadMore(): Promise<void> {
    if (activeRun || !hasMore.value || isLoading.value) return
    return fetchNextPage()
  }

  async function retry(): Promise<void> {
    if (activeRun || !canRetry.value || isLoading.value) return
    return fetchNextPage()
  }

  const debouncedRun = useDebounceFn(() => runQuery(), 200)

  // The words this list was last asked for. The field is shared with the pages
  // the view pushes on top of itself, and the view stays mounted under them, so
  // typing over there would otherwise run a full-catalog FTS pass per pause
  // that nothing renders. Comparing against what was searched — rather than
  // just resuming — makes the return trip free when the words came back
  // unchanged, and still re-runs the ones that were retyped elsewhere: the rows
  // under the field are always for the words in it.
  let searched = options.query.value

  watch([options.query, options.enabled], () => {
    if (!options.enabled.value || options.query.value === searched) return
    searched = options.query.value
    void debouncedRun()
  })

  return { rawTracks, isLoading, error, hasMore, canRetry, runQuery, loadMore, retry }
}

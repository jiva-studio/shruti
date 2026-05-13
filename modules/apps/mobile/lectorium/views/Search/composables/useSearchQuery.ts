import { ref, watch, type Ref } from "vue"
import { useDebounceFn } from "@vueuse/core"
import { searchAndFilterTracks } from "@lib/application/searchAndFilterTracks.js"
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
}

export interface UseSearchQueryReturn {
  rawTracks: Ref<readonly Track[]>
  isLoading: Ref<boolean>
  error: Ref<string | null>
  hasMore: Ref<boolean>
  /** Re-runs the query immediately and resets pagination. */
  runQuery: () => Promise<void>
  /** Loads the next page when `hasMore` is true. */
  loadMore: () => Promise<void>
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
 * MATCH in the plugin's queue.
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
        durationFilter: options.filters.value.duration as DurationFilterId | undefined,
        sortBy: options.filters.value.sort as SortMethod | undefined,
        limit: PAGE_SIZE,
        offset: pageOffset,
      },
      { tracks: options.tracks }
    )
  }

  let activeRun: Promise<void> | null = null
  let rerunPending = false

  async function runQuery(): Promise<void> {
    if (activeRun) {
      rerunPending = true
      return activeRun
    }
    activeRun = (async () => {
      try {
        do {
          rerunPending = false
          const token = ++searchToken
          error.value = null
          offset.value = 0
          hasMore.value = false
          isLoading.value = true
          try {
            const tracks = await fetchPage(0)
            if (token !== searchToken) continue
            rawTracks.value = tracks
            hasMore.value = tracks.length >= PAGE_SIZE
            offset.value = PAGE_SIZE
          } catch (err) {
            if (token !== searchToken) continue
            error.value = err instanceof Error ? err.message : "Search failed"
            rawTracks.value = []
          } finally {
            if (token === searchToken) isLoading.value = false
          }
        } while (rerunPending)
      } finally {
        activeRun = null
      }
    })()
    return activeRun
  }

  async function loadMore(): Promise<void> {
    if (!hasMore.value || isLoading.value) return
    const token = searchToken
    const pageOffset = offset.value
    try {
      const tracks = await fetchPage(pageOffset)
      if (token !== searchToken) return
      rawTracks.value = [...rawTracks.value, ...tracks]
      hasMore.value = tracks.length >= PAGE_SIZE
      offset.value = pageOffset + PAGE_SIZE
    } catch (err) {
      if (token !== searchToken) return
      error.value = err instanceof Error ? err.message : "Search failed"
    }
  }

  const debouncedRun = useDebounceFn(() => runQuery(), 200)
  watch(options.query, () => {
    void debouncedRun()
  })

  return { rawTracks, isLoading, error, hasMore, runQuery, loadMore }
}

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
  /** Returns true when at least one filter is set. */
  hasActiveFilter: () => boolean
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
 * Owns server-side search pagination and the race-guard token.
 *
 * The text-input watcher debounces keystrokes (200 ms) so fast typing
 * doesn't spam SQL. Filter mutations should call `runQuery()` directly —
 * they fire once per gesture and don't need debouncing.
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
        durationFilter: options.filters.value.duration as DurationFilterId | undefined,
        sortBy: options.filters.value.sort as SortMethod | undefined,
        limit: PAGE_SIZE,
        offset: pageOffset,
      },
      { tracks: options.tracks }
    )
  }

  async function runQuery(): Promise<void> {
    const token = ++searchToken
    error.value = null
    const text = options.query.value.trim()
    const hasFilter = options.hasActiveFilter()

    offset.value = 0
    hasMore.value = false

    if (!text && !hasFilter) {
      rawTracks.value = []
      isLoading.value = false
      return
    }

    isLoading.value = true
    try {
      const tracks = await fetchPage(0)
      if (token !== searchToken) return
      rawTracks.value = tracks
      // When FTS + client-side filter trims the page heavily we can get
      // a short page while the DB still has more rows. Use raw page size
      // as the stop signal — `loadMore` keeps fetching until the DB
      // itself returns nothing.
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

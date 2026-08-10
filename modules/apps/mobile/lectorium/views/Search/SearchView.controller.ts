import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useTrackActionSheet } from "@lectorium/composables/useTrackActionSheet.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import type { TrackId } from "@lib/domain/core.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import type {
  FiltersModel,
  SearchFilterSectionDef,
} from "@ui/features/tracks/search/filters/index.js"
import { useSearchQuery } from "./composables/useSearchQuery.js"
import { useSearchDock } from "@lectorium/composables/useSearchDock.js"
import { useSearchFiltersBinding } from "./composables/useSearchFiltersBinding.js"
import { useSearchFilterSections } from "./composables/useSearchFilterSections.js"

export interface SearchControllerReturn {
  query: Ref<string>
  rows: ComputedRef<readonly UiTrackRow[]>
  isLoading: Ref<boolean>
  error: Ref<string | null>
  emptyMessage: ComputedRef<string>
  /** True once the first query has run and yielded zero rows with no error —
   *  the cue to show the "nothing matches your filters" empty state. */
  showEmptyState: ComputedRef<boolean>
  filters: Ref<FiltersModel>
  hasMore: Ref<boolean>
  /** A page fetch failed — the list offers to fetch it again. */
  canRetry: Ref<boolean>
  filterSections: ComputedRef<readonly SearchFilterSectionDef[]>
  filtersOpen: Ref<boolean>
  activeFilterCount: ComputedRef<number>
  /** Sections a fresh install never chose (seeded language, default sort) —
   *  the chips leave these out. */
  defaultSections: ComputedRef<ReadonlySet<string>>
  resetFilters: () => Promise<void>
  /** Tap on a track row → open the per-track sheet (any download state). */
  onSelect: (trackId: string) => Promise<void>
  loadMore: () => Promise<void>
  /** Fetch the page that failed, again. */
  retry: () => Promise<void>
}

export function useSearchController(): SearchControllerReturn {
  const app = useLectorium()
  const repos = app.repositories()
  const dictionaries = useDictionariesStore()

  // Not this controller's own ref: the field that writes it is docked at the
  // root, above the page stack, and the pages it floats over read it too.
  const { text: query } = useSearchDock()
  const {
    filters,
    ready: filtersReady,
    activeFilterCount,
    defaultSections,
    reset: resetFilters,
  } = useSearchFiltersBinding()
  const { sections: filterSections } = useSearchFilterSections()
  const { mapRows } = useTrackUiStateMapper()
  const actionSheet = useTrackActionSheet()
  const filtersOpen = ref<boolean>(false)
  // Stays false until the first query settles, so the empty state never flashes
  // during the initial filter/dictionary hydration before any search has run.
  const hasRun = ref<boolean>(false)

  const { rawTracks, isLoading, error, hasMore, canRetry, runQuery, loadMore, retry } =
    useSearchQuery({
      query,
      filters,
      tracks: repos.tracks,
    })

  onMounted(async () => {
    await filtersReady
    await dictionaries.ensureLoaded()
    await runQuery()
    hasRun.value = true
  })

  // Filter edits fire once per gesture — re-run immediately, not debounced.
  watch(
    filters,
    () => {
      void runQuery()
    },
    { deep: true }
  )

  const rows = mapRows(() => rawTracks.value, { context: "discovery" })

  // Empty query + no filters now lists the full catalog (paginated), so
  // there's no "specify search criteria" prompt on the fresh state. The
  // computed remains for future no-results / error messaging.
  const emptyMessage = computed(() => "")

  const showEmptyState = computed(
    () => hasRun.value && !isLoading.value && !error.value && rows.value.length === 0
  )

  async function onSelect(trackId: string): Promise<void> {
    // Always open the per-track sheet — regardless of download state. A
    // failed/stuck download is retried from the sheet's primary button
    // ("Download again"), not by tapping the row, so the user can always
    // reach the lecture's details, transcript, and share actions.
    await actionSheet.present(trackId as TrackId)
  }

  return {
    query,
    rows,
    isLoading,
    error,
    emptyMessage,
    showEmptyState,
    filters,
    hasMore,
    canRetry,
    filterSections,
    filtersOpen,
    activeFilterCount,
    defaultSections,
    resetFilters,
    onSelect,
    loadMore,
    retry,
  }
}

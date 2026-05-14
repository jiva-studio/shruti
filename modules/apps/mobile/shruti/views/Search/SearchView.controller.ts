import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { useTrackActionSheet } from "@shruti/composables/useTrackActionSheet.js"
import { useTrackUiStateMapper } from "@shruti/composables/useTrackUiStateMapper.js"
import type { TrackId } from "@lib/domain/core.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import type {
  FiltersModel,
  SearchFilterSectionDef,
} from "@ui/features/tracks/search/filters/index.js"
import { useSearchQuery } from "./composables/useSearchQuery.js"
import { useSearchFiltersBinding } from "./composables/useSearchFiltersBinding.js"
import { useSearchFilterSections } from "./composables/useSearchFilterSections.js"

export interface SearchControllerReturn {
  query: Ref<string>
  rows: ComputedRef<readonly UiTrackRow[]>
  isLoading: Ref<boolean>
  error: Ref<string | null>
  emptyMessage: ComputedRef<string>
  filters: Ref<FiltersModel>
  hasMore: Ref<boolean>
  filterSections: ComputedRef<readonly SearchFilterSectionDef[]>
  filtersOpen: Ref<boolean>
  activeFilterCount: ComputedRef<number>
  resetFilters: () => Promise<void>
  /** Tap on a track row → retry download if failed, else open the
   *  per-track ActionSheet. */
  onSelect: (trackId: string) => Promise<void>
  loadMore: () => Promise<void>
}

export function useSearchController(): SearchControllerReturn {
  const app = useShruti()
  const repos = app.repositories()
  const dictionaries = useDictionariesStore()

  const query = ref<string>("")
  const {
    filters,
    ready: filtersReady,
    activeFilterCount,
    reset: resetFilters,
  } = useSearchFiltersBinding()
  const { sections: filterSections } = useSearchFilterSections()
  const { mapRows } = useTrackUiStateMapper()
  const actionSheet = useTrackActionSheet()
  const downloads = useDownloadStore()
  const filtersOpen = ref<boolean>(false)

  const { rawTracks, isLoading, error, hasMore, runQuery, loadMore } = useSearchQuery({
    query,
    filters,
    tracks: repos.tracks,
  })

  onMounted(async () => {
    await filtersReady
    await dictionaries.ensureLoaded()
    await runQuery()
  })

  // Filter edits fire once per gesture — re-run immediately, not debounced.
  watch(
    filters,
    () => {
      void runQuery()
    },
    { deep: true }
  )

  const rows = mapRows(() => rawTracks.value)

  // Empty query + no filters now lists the full catalog (paginated), so
  // there's no "specify search criteria" prompt on the fresh state. The
  // computed remains for future no-results / error messaging.
  const emptyMessage = computed(() => "")

  async function onSelect(trackId: string): Promise<void> {
    // Failed downloads retry on tap — no ActionSheet. The red X IS the
    // retry affordance; ensureDownloaded de-dupes via `inFlight`.
    if (downloads.getState(trackId) === "failed") {
      const track = rawTracks.value.find((t) => t.id === trackId)
      const variant = track?.variants.find((v) => v.audio)
      if (variant?.audio) {
        void downloads.ensureDownloaded(trackId as TrackId, variant.audio.path)
      }
      return
    }
    await actionSheet.present(trackId as TrackId)
  }

  return {
    query,
    rows,
    isLoading,
    error,
    emptyMessage,
    filters,
    hasMore,
    filterSections,
    filtersOpen,
    activeFilterCount,
    resetFilters,
    onSelect,
    loadMore,
  }
}

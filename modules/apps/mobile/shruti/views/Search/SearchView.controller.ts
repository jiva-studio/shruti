import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useShruti } from "@shruti/shruti.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import {
  useTrackActionSheet,
  type UseTrackActionSheetReturn,
} from "@shruti/composables/useTrackActionSheet.js"
import { useTrackUiStateMapper } from "@shruti/composables/useTrackUiStateMapper.js"
import type { TrackId } from "@lib/domain/core.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import type { FiltersModel, SearchFilterChipDef } from "@ui/features/tracks/search/filters/index.js"
import { useSearchQuery } from "./composables/useSearchQuery.js"
import { useSearchFiltersBinding } from "./composables/useSearchFiltersBinding.js"
import { useSearchFilterChips } from "./composables/useSearchFilterChips.js"

export interface SearchControllerReturn {
  query: Ref<string>
  rows: ComputedRef<readonly UiTrackRow[]>
  isLoading: Ref<boolean>
  error: Ref<string | null>
  emptyMessage: ComputedRef<string>
  filters: Ref<FiltersModel>
  hasMore: Ref<boolean>
  filterChips: ComputedRef<readonly SearchFilterChipDef[]>
  /** Tap on a track row → open the per-track ActionSheet. */
  onSelect: (trackId: string) => Promise<void>
  loadMore: () => Promise<void>
  actionSheet: UseTrackActionSheetReturn
}

export function useSearchController(): SearchControllerReturn {
  const app = useShruti()
  const repos = app.repositories()
  const dictionaries = useDictionariesStore()
  const { t } = useI18n()

  const query = ref<string>("")
  const { filters, hasActiveFilter, ready: filtersReady } = useSearchFiltersBinding()
  const { chips: filterChips } = useSearchFilterChips()
  const { mapRows } = useTrackUiStateMapper()
  const actionSheet = useTrackActionSheet()

  const { rawTracks, isLoading, error, hasMore, runQuery, loadMore } = useSearchQuery({
    query,
    filters,
    tracks: repos.tracks,
    hasActiveFilter,
  })

  onMounted(async () => {
    await filtersReady
    await dictionaries.ensureLoaded()
    await runQuery()
  })

  // Filter chips fire once per gesture — re-run immediately, not debounced.
  watch(
    filters,
    () => {
      void runQuery()
    },
    { deep: true }
  )

  const rows = mapRows(() => rawTracks.value)

  const emptyMessage = computed(() => {
    if (isLoading.value) return ""
    if (!query.value.trim() && !hasActiveFilter()) {
      return t("search.specifySearchCriteria")
    }
    return ""
  })

  async function onSelect(trackId: string): Promise<void> {
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
    filterChips,
    onSelect,
    loadMore,
    actionSheet,
  }
}

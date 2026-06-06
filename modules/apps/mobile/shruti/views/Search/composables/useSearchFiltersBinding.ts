import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useSearchFiltersStore } from "@shruti/stores/useSearchFiltersStore.js"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"

export interface UseSearchFiltersBindingReturn {
  filters: Ref<FiltersModel>
  hasActiveFilter: () => boolean
  /** Number of active filter values across all dimensions — used by the
   *  Filters button badge so the user sees the live count without
   *  opening the sheet. */
  activeFilterCount: ComputedRef<number>
  /** Clear every dimension in a single round-trip. Live-apply UI uses
   *  this for the sheet's Reset action. */
  reset: () => Promise<void>
  /** Resolves once the persisted filter snapshot has been hydrated. */
  ready: Promise<void>
}

/**
 * Two-way binding between an in-memory `FiltersModel` ref and the
 * persisted filter store. On mount the ref is hydrated from the store;
 * subsequent edits to the ref write back to the store. The
 * `hasActiveFilter` predicate centralises the "is anything set?" check
 * so callers don't duplicate the empty-array / empty-string checks.
 */
export function useSearchFiltersBinding(): UseSearchFiltersBindingReturn {
  const store = useSearchFiltersStore()
  const filters = ref<FiltersModel>({})

  const ready = (async () => {
    await store.load()
    filters.value = {
      authors: [...store.authorIds],
      languages: [...store.languageCodes],
      locations: [...store.locationIds],
      sources: [...store.sourceIds],
      tags: [...store.tagIds],
      duration: store.duration[0],
      sort: store.sort,
      dateFrom: store.dateFrom,
      dateTo: store.dateTo,
    }
  })()

  onMounted(() => {
    void ready
  })

  watch(
    filters,
    (next) => {
      void store.setAuthors(next.authors ?? [])
      void store.setLanguages(next.languages ?? [])
      void store.setLocations(next.locations ?? [])
      void store.setSources(next.sources ?? [])
      void store.setTags(next.tags ?? [])
      void store.setDuration(next.duration ? [next.duration as DurationFilterId] : [])
      void store.setSort(next.sort as SortMethod | undefined)
      void store.setDateFrom(next.dateFrom)
      void store.setDateTo(next.dateTo)
    },
    { deep: true }
  )

  function hasActiveFilter(): boolean {
    const f = filters.value
    return (
      (f.authors?.length ?? 0) > 0 ||
      (f.languages?.length ?? 0) > 0 ||
      (f.locations?.length ?? 0) > 0 ||
      (f.sources?.length ?? 0) > 0 ||
      (f.tags?.length ?? 0) > 0 ||
      (f.duration !== undefined && f.duration !== "") ||
      (f.sort !== undefined && f.sort !== "") ||
      f.dateFrom !== undefined ||
      f.dateTo !== undefined
    )
  }

  const activeFilterCount = computed<number>(() => {
    const f = filters.value
    return (
      (f.authors?.length ?? 0) +
      (f.languages?.length ?? 0) +
      (f.locations?.length ?? 0) +
      (f.sources?.length ?? 0) +
      (f.tags?.length ?? 0) +
      (f.duration !== undefined && f.duration !== "" ? 1 : 0) +
      (f.sort !== undefined && f.sort !== "" ? 1 : 0) +
      (f.dateFrom !== undefined || f.dateTo !== undefined ? 1 : 0)
    )
  })

  async function reset(): Promise<void> {
    filters.value = {
      authors: [],
      languages: [],
      locations: [],
      sources: [],
      tags: [],
      duration: undefined,
      sort: undefined,
      dateFrom: undefined,
      dateTo: undefined,
    }
  }

  return { filters, hasActiveFilter, activeFilterCount, reset, ready }
}

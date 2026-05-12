import { onMounted, ref, watch, type Ref } from "vue"
import { useSearchFiltersStore } from "@shruti/stores/useSearchFiltersStore.js"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"

export interface UseSearchFiltersBindingReturn {
  filters: Ref<FiltersModel>
  hasActiveFilter: () => boolean
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
      duration: store.duration[0],
      sort: store.sort,
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
      void store.setDuration(next.duration ? [next.duration as DurationFilterId] : [])
      void store.setSort(next.sort as SortMethod | undefined)
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
      (f.duration !== undefined && f.duration !== "") ||
      (f.sort !== undefined && f.sort !== "")
    )
  }

  return { filters, hasActiveFilter, ready }
}

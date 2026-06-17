import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useSearchFiltersStore } from "@shruti/stores/useSearchFiltersStore.js"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"

// First-launch seed written by useSearchFiltersStore: oldest-first sort and
// the locale-derived library language(s). The Filters badge must not count
// these as "active" or a pristine install shows "2".
const DEFAULT_SORT: SortMethod = "byDateAsc"

/** Order-independent equality of two language-code lists. */
function sameLanguageSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

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
  // The locale-derived library language(s) the store seeds on first launch;
  // used to keep the pristine-install language selection out of the active
  // count. Populated from the store once it has loaded.
  const seededLanguages = ref<readonly string[]>([])
  // Set while the initial hydration assigns `filters.value`, so the deep
  // watcher doesn't echo every just-loaded value straight back to the store.
  let hydrating = false

  const ready = (async () => {
    await store.load()
    seededLanguages.value = [...store.localeLanguageDefault]
    hydrating = true
    filters.value = {
      authors: [...store.authorIds],
      languages: [...store.languageCodes],
      locations: [...store.locationIds],
      sources: [...store.sourceIds],
      tags: [...store.tagIds],
      topics: [...store.topicIds],
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
      // Skip the echo from the hydration assignment above.
      if (hydrating) {
        hydrating = false
        return
      }
      void store.setAuthors(next.authors ?? [])
      void store.setLanguages(next.languages ?? [])
      void store.setLocations(next.locations ?? [])
      void store.setSources(next.sources ?? [])
      void store.setTags(next.tags ?? [])
      void store.setTopics(next.topics ?? [])
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
      (f.topics?.length ?? 0) > 0 ||
      (f.duration !== undefined && f.duration !== "") ||
      (f.sort !== undefined && f.sort !== "") ||
      f.dateFrom !== undefined ||
      f.dateTo !== undefined
    )
  }

  const activeFilterCount = computed<number>(() => {
    const f = filters.value
    // The seeded device-locale language and the default sort aren't user
    // choices, so they don't count toward the badge — a pristine install
    // reads 0. A language list that is exactly the seeded locale is the
    // untouched default; anything else (cleared, or extra langs) counts.
    const langs = f.languages ?? []
    const isSeededLangDefault =
      seededLanguages.value.length > 0 && sameLanguageSet(langs, seededLanguages.value)
    const languageCount = isSeededLangDefault ? 0 : langs.length
    const sortIsActive = f.sort !== undefined && f.sort !== "" && f.sort !== DEFAULT_SORT
    return (
      (f.authors?.length ?? 0) +
      languageCount +
      (f.locations?.length ?? 0) +
      (f.sources?.length ?? 0) +
      (f.tags?.length ?? 0) +
      (f.topics?.length ?? 0) +
      (f.duration !== undefined && f.duration !== "" ? 1 : 0) +
      (sortIsActive ? 1 : 0) +
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
      topics: [],
      duration: undefined,
      sort: undefined,
      dateFrom: undefined,
      dateTo: undefined,
    }
  }

  return { filters, hasActiveFilter, activeFilterCount, reset, ready }
}

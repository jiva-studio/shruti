import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useAutoDownloadFiltersStore } from "@lectorium/stores/useAutoDownloadFiltersStore.js"
import type { AutoArchiveDelay } from "@lectorium/composables/useAutoArchiveSweep.js"
import { useSearchFilterSections } from "@lectorium/views/Search/composables/useSearchFilterSections.js"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import type {
  FiltersModel,
  SearchFilterSectionDef,
} from "@ui/features/tracks/search/filters/index.js"
import { getSectionSummary } from "@ui/features/tracks/search/filters/filtersModel.js"

const PRESETS = [
  { id: "off" as const, seconds: 0 },
  { id: "30m" as const, seconds: 30 * 60 },
  { id: "1h" as const, seconds: 60 * 60 },
  { id: "2h" as const, seconds: 2 * 60 * 60 },
  { id: "3h" as const, seconds: 3 * 60 * 60 },
  { id: "5h" as const, seconds: 5 * 60 * 60 },
  { id: "8h" as const, seconds: 8 * 60 * 60 },
  { id: "10h" as const, seconds: 10 * 60 * 60 },
]

export interface UseSmartLibraryBindingReturn {
  filters: Ref<FiltersModel>
  sections: ComputedRef<readonly SearchFilterSectionDef[]>
  filterSummary: ComputedRef<string>
  subtitle: ComputedRef<string>
  activeFilterCount: ComputedRef<number>
  reset: () => Promise<void>
}

export function useSmartLibraryBinding(
  targetSeconds: Ref<number>,
  archiveDelay: Ref<AutoArchiveDelay>,
  isSubscribed: Ref<boolean>
): UseSmartLibraryBindingReturn {
  const { t } = useI18n()
  const store = useAutoDownloadFiltersStore()
  const { sections } = useSearchFilterSections()

  const filters = ref<FiltersModel>({})
  // Set while the initial hydration assigns `filters.value`, so the deep
  // watcher doesn't echo every just-loaded value straight back to the store.
  let hydrating = false

  const ready = (async () => {
    await store.load()
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

  const activeFilterCount = computed<number>(() => {
    const f = filters.value
    return (
      (f.authors?.length ?? 0) +
      (f.languages?.length ?? 0) +
      (f.locations?.length ?? 0) +
      (f.sources?.length ?? 0) +
      (f.tags?.length ?? 0) +
      (f.topics?.length ?? 0) +
      (f.duration !== undefined && f.duration !== "" ? 1 : 0) +
      (f.sort !== undefined && f.sort !== "" ? 1 : 0) +
      (f.dateFrom !== undefined || f.dateTo !== undefined ? 1 : 0)
    )
  })

  const filterSummary = computed<string>(() =>
    sections.value
      .map((s) => getSectionSummary(filters.value, s))
      .filter((s) => s.length > 0)
      .join(", ")
  )

  const targetLabel = computed<string>(() => {
    const preset = PRESETS.find((p) => p.seconds === targetSeconds.value)
    const id = preset ? preset.id : "off"
    return t(`settings.smartLibrary.target.${id}`)
  })

  const archiveLabel = computed<string>(() => {
    if (archiveDelay.value === "off") return ""
    const key = archiveDelay.value === "immediate" ? "immediate" : `_${archiveDelay.value}`
    const localized = t(`settings.smartLibrary.archive.${key}`).toLowerCase()
    return `${t("settings.smartLibrary.subtitleArchivePrefix")} ${localized}`
  })

  const subtitle = computed<string>(() => {
    if (targetSeconds.value === 0 || !isSubscribed.value)
      return t("settings.smartLibrary.subtitleOff")
    const parts = [targetLabel.value]
    if (filterSummary.value) parts.push(filterSummary.value)
    if (archiveLabel.value) parts.push(archiveLabel.value)
    return parts.join(" · ")
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

  return { filters, sections, filterSummary, subtitle, activeFilterCount, reset }
}

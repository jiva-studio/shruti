import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useAutoDownloadFiltersStore } from "@shruti/stores/useAutoDownloadFiltersStore.js"
import { useSearchFilterSections } from "@shruti/views/Search/composables/useSearchFilterSections.js"
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

export interface UseAutoDownloadBindingReturn {
  /** Two-way model fed into `SearchFiltersSheet`; writes are mirrored
   *  to the persisted store. */
  filters: Ref<FiltersModel>
  sections: ComputedRef<readonly SearchFilterSectionDef[]>
  /** Comma-separated localized names of every selected filter value,
   *  used for the row subtitle and the dialog's filter row. */
  filterSummary: ComputedRef<string>
  /** Display string for the settings row: target label plus filter
   *  summary, or the static description when the feature is off. */
  subtitle: ComputedRef<string>
  activeFilterCount: ComputedRef<number>
  reset: () => Promise<void>
}

/**
 * Glue between the auto-download filter store, the shared search-filter
 * section definitions, and the UI dialog/row. Lives in the composition
 * root so the UI components stay free of `@shruti`/`@lib` imports.
 */
export function useAutoDownloadBinding(targetSeconds: Ref<number>): UseAutoDownloadBindingReturn {
  const { t } = useI18n()
  const store = useAutoDownloadFiltersStore()
  const { sections } = useSearchFilterSections()

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
      (f.duration !== undefined && f.duration !== "" ? 1 : 0) +
      (f.sort !== undefined && f.sort !== "" ? 1 : 0)
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
    return t(`settings.autoDownload.target.${id}`)
  })

  const subtitle = computed<string>(() => {
    if (targetSeconds.value === 0) return t("settings.autoDownload.description")
    const parts = [targetLabel.value]
    if (filterSummary.value) parts.push(filterSummary.value)
    return parts.join(" · ")
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
    }
  }

  return { filters, sections, filterSummary, subtitle, activeFilterCount, reset }
}

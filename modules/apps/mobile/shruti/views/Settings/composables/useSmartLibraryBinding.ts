import { computed, type ComputedRef, type Ref, type WritableComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAutoDownloadFiltersStore } from "@shruti/stores/useAutoDownloadFiltersStore.js"
import type { AutoArchiveDelay } from "@shruti/composables/useAutoArchiveSweep.js"
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

export interface UseSmartLibraryBindingReturn {
  filters: WritableComputedRef<FiltersModel>
  sections: ComputedRef<readonly SearchFilterSectionDef[]>
  filterSummary: ComputedRef<string>
  subtitle: ComputedRef<string>
  activeFilterCount: ComputedRef<number>
  reset: () => Promise<void>
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

/**
 * Binds the search-filters sheet to the persisted auto-download filters.
 *
 * `filters` is a **view over the shared store**, never a snapshot of it. Every
 * call site holds its own composable instance — Settings and the Library
 * landing both do, and Ionic keeps both alive for the app's lifetime — so a
 * private hydrated-once ref meant whichever instance was created first showed
 * stale values and, on the next edit, wrote its whole stale snapshot back over
 * everything the other one had persisted (#1853). The values at stake decide
 * what the device downloads (`useAutoDownloadLoop`), so that loss was silent
 * and material.
 *
 * Reading through a `computed` also keeps the third writer visible: chat's
 * `applyProactiveSmartLibrary` sets the store directly, and every mounted
 * binding now re-derives from it instead of ignoring it.
 *
 * The setter writes back only the dimensions that actually differ, so a sheet
 * that hands back a whole `FiltersModel` (they are rebuilt fresh on every
 * toggle) cannot restate — and therefore cannot clobber — the other nine.
 */
export function useSmartLibraryBinding(
  targetSeconds: Ref<number>,
  archiveDelay: Ref<AutoArchiveDelay>,
  isSubscribed: Ref<boolean>
): UseSmartLibraryBindingReturn {
  const { t } = useI18n()
  const store = useAutoDownloadFiltersStore()
  const { sections } = useSearchFilterSections()

  const ready = store.load()

  async function write(next: FiltersModel): Promise<void> {
    // A write landing before the persisted set is in memory would persist the
    // empty defaults over it.
    await ready
    if (!sameIds(store.authorIds, next.authors ?? [])) await store.setAuthors(next.authors ?? [])
    if (!sameIds(store.languageCodes, next.languages ?? []))
      await store.setLanguages(next.languages ?? [])
    if (!sameIds(store.locationIds, next.locations ?? []))
      await store.setLocations(next.locations ?? [])
    if (!sameIds(store.sourceIds, next.sources ?? [])) await store.setSources(next.sources ?? [])
    if (!sameIds(store.tagIds, next.tags ?? [])) await store.setTags(next.tags ?? [])
    if (!sameIds(store.topicIds, next.topics ?? [])) await store.setTopics(next.topics ?? [])
    const nextDuration = next.duration ? [next.duration as DurationFilterId] : []
    if (!sameIds(store.duration, nextDuration)) await store.setDuration(nextDuration)
    if (store.sort !== next.sort) await store.setSort(next.sort as SortMethod | undefined)
    if (store.dateFrom !== next.dateFrom) await store.setDateFrom(next.dateFrom)
    if (store.dateTo !== next.dateTo) await store.setDateTo(next.dateTo)
  }

  const filters = computed<FiltersModel>({
    get: () => ({
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
    }),
    set: (next) => void write(next),
  })

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
    await ready
    await store.clearAll()
  }

  return { filters, sections, filterSummary, subtitle, activeFilterCount, reset }
}

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
import { countActiveFilters } from "@shruti/views/Search/composables/activeFilters.js"

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

async function writeList(
  current: readonly string[],
  next: readonly string[],
  apply: (value: string[]) => Promise<void>
): Promise<void> {
  if (!sameIds(current, next)) await apply([...next])
}

async function writeValue<T>(
  current: T,
  next: T,
  apply: (value: T) => Promise<void>
): Promise<void> {
  if (current !== next) await apply(next)
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
    await writeList(store.authorIds, next.authors ?? [], (v) => store.setAuthors(v))
    await writeList(store.languageCodes, next.languages ?? [], (v) => store.setLanguages(v))
    await writeList(store.locationIds, next.locations ?? [], (v) => store.setLocations(v))
    await writeList(store.sourceIds, next.sources ?? [], (v) => store.setSources(v))
    await writeList(store.tagIds, next.tags ?? [], (v) => store.setTags(v))
    await writeList(store.topicIds, next.topics ?? [], (v) => store.setTopics(v))
    const nextDuration = next.duration ? [next.duration as DurationFilterId] : []
    await writeList(store.duration, nextDuration, (v) => store.setDuration(v as DurationFilterId[]))
    await writeValue(store.sort, next.sort, (v) => store.setSort(v as SortMethod | undefined))
    await writeValue(store.dateFrom, next.dateFrom, (v) => store.setDateFrom(v))
    await writeValue(store.dateTo, next.dateTo, (v) => store.setDateTo(v))
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

  const activeFilterCount = computed<number>(() => countActiveFilters(filters.value))

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

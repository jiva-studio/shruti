import { defineStore } from "pinia"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { useToast } from "@kit/composables"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { detectDeviceLocaleAsync } from "@lectorium/i18n/index.js"
import { createFiltersState, parsePersistedFilters } from "./filters/persistedFilters.js"
import { pickSeedLanguages, type LanguageSeed } from "./filters/localeLanguageSeed.js"

// Every install reads v3 as absent and gets the locale-seeded defaults written
// in; the v2 key is left orphaned in Preferences.
const STORAGE_KEY = "search.filters.v3"

/**
 * Selected search filters mirrored to `IPreferences` so they survive restarts.
 * Mutations go through setters so the store owns persistence — views never
 * touch preferences directly.
 */
export const useSearchFiltersStore = defineStore("searchFilters", () => {
  const app = useLectorium()
  const { t } = useI18n()
  const toast = useToast()

  const state = createFiltersState()
  const loaded = ref<boolean>(false)
  // The untouched locale-derived baseline, so the Filters badge can tell a
  // pristine language selection from a deliberate one.
  const localeLanguageDefault = ref<readonly string[]>([])

  async function computeLocaleDefault(): Promise<LanguageSeed> {
    const locale = await detectDeviceLocaleAsync()
    let available: string[]
    try {
      available = (await app.repositories().languages.listWithTracks()).map((l) => l.code)
    } catch {
      available = []
    }
    return pickSeedLanguages(locale, available)
  }

  async function load(): Promise<void> {
    if (loaded.value) return
    const seed = await computeLocaleDefault()
    localeLanguageDefault.value = seed.languages

    const raw = await app.preferences.get(STORAGE_KEY)
    const stored = raw ? parsePersistedFilters(raw) : undefined
    if (stored) {
      state.apply(stored)
      loaded.value = true
      return
    }
    // Nothing stored, or something stored we cannot read. A payload that will
    // not parse used to mark the store loaded having applied nothing, which
    // left no language filter at all — the whole multi-language library
    // instead of the locale default a first launch gets. Seed it either way.
    state.languageCodes.value = [...seed.languages]
    state.sort.value = "byDateAsc"
    loaded.value = true
    // A seed guessed without the catalog is for this session only; persisting
    // it would freeze the guess and skip the constrained re-derivation once the
    // content DB is available.
    if (seed.fromDb) await persist()
  }

  async function persist(): Promise<void> {
    try {
      await app.preferences.set(STORAGE_KEY, JSON.stringify(state.snapshot()))
    } catch (e) {
      // The selection is applied in memory but won't survive a restart — say so
      // instead of leaking an unhandled rejection out of the setter.
      console.warn("[filters] persist failed:", e)
      void toast.error(t("errors.filtersNotSaved"))
    }
  }

  async function setAuthors(ids: readonly string[]): Promise<void> {
    state.authorIds.value = ids
    await persist()
  }

  async function setLanguages(ids: readonly string[]): Promise<void> {
    state.languageCodes.value = ids
    await persist()
  }

  async function setLocations(ids: readonly string[]): Promise<void> {
    state.locationIds.value = ids
    await persist()
  }

  async function setSources(ids: readonly string[]): Promise<void> {
    state.sourceIds.value = ids
    await persist()
  }

  async function setTags(ids: readonly string[]): Promise<void> {
    state.tagIds.value = ids
    await persist()
  }

  async function setTopics(ids: readonly string[]): Promise<void> {
    state.topicIds.value = ids
    await persist()
  }

  async function setDuration(ids: readonly DurationFilterId[]): Promise<void> {
    state.duration.value = ids
    await persist()
  }

  async function setSort(value: SortMethod | undefined): Promise<void> {
    state.sort.value = value
    await persist()
  }

  async function setDateFrom(value: string | undefined): Promise<void> {
    state.dateFrom.value = value
    await persist()
  }

  async function setDateTo(value: string | undefined): Promise<void> {
    state.dateTo.value = value
    await persist()
  }

  async function clearAll(): Promise<void> {
    state.clear()
    await persist()
  }

  /** Drops in-memory state without writing; the caller has already removed the persisted key. */
  function reset(): void {
    state.clear()
    loaded.value = false
  }

  return {
    authorIds: state.authorIds,
    languageCodes: state.languageCodes,
    locationIds: state.locationIds,
    sourceIds: state.sourceIds,
    tagIds: state.tagIds,
    topicIds: state.topicIds,
    duration: state.duration,
    sort: state.sort,
    dateFrom: state.dateFrom,
    dateTo: state.dateTo,
    loaded,
    localeLanguageDefault,
    load,
    setAuthors,
    setLanguages,
    setLocations,
    setSources,
    setTags,
    setTopics,
    setDuration,
    setSort,
    setDateFrom,
    setDateTo,
    clearAll,
    reset,
  }
})

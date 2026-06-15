import { defineStore } from "pinia"
import { ref } from "vue"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { detectDeviceLocaleAsync } from "@lectorium/i18n/index.js"

// v3 introduces locale-seeded defaults on first launch (issue #411). The
// version bump is intentional: every install — fresh or upgraded from v2 —
// reads v3 as absent and gets the seeded defaults written in. The old v2
// key is left orphaned in Preferences.
const STORAGE_KEY = "search.filters.v3"

export interface PersistedFilters {
  authorIds: readonly string[]
  languageCodes: readonly string[]
  locationIds: readonly string[]
  sourceIds: readonly string[]
  tagIds: readonly string[]
  topicIds: readonly string[]
  duration: readonly DurationFilterId[]
  sort: SortMethod | undefined
  /** Date-range edges — `"YYYY"` / `"YYYY-MM"` or undefined for open ends. */
  dateFrom: string | undefined
  dateTo: string | undefined
}

const EMPTY: PersistedFilters = {
  authorIds: [],
  languageCodes: [],
  locationIds: [],
  sourceIds: [],
  tagIds: [],
  topicIds: [],
  duration: [],
  sort: undefined,
  dateFrom: undefined,
  dateTo: undefined,
}

/**
 * Selected search filters mirrored to `IPreferences` so they survive
 * restarts. Mutations go through setters so the store owns persistence —
 * views never touch preferences directly.
 */
export const useSearchFiltersStore = defineStore("searchFilters", () => {
  const app = useLectorium()

  const authorIds = ref<readonly string[]>([])
  const languageCodes = ref<readonly string[]>([])
  const locationIds = ref<readonly string[]>([])
  const sourceIds = ref<readonly string[]>([])
  const tagIds = ref<readonly string[]>([])
  const topicIds = ref<readonly string[]>([])
  const duration = ref<readonly DurationFilterId[]>([])
  const sort = ref<PersistedFilters["sort"]>(undefined)
  const dateFrom = ref<string | undefined>(undefined)
  const dateTo = ref<string | undefined>(undefined)
  const loaded = ref<boolean>(false)

  async function load(): Promise<void> {
    if (loaded.value) return
    const raw = await app.preferences.get(STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<PersistedFilters>
        authorIds.value = parsed.authorIds ?? EMPTY.authorIds
        languageCodes.value = parsed.languageCodes ?? EMPTY.languageCodes
        locationIds.value = parsed.locationIds ?? EMPTY.locationIds
        sourceIds.value = parsed.sourceIds ?? EMPTY.sourceIds
        tagIds.value = parsed.tagIds ?? EMPTY.tagIds
        topicIds.value = parsed.topicIds ?? EMPTY.topicIds
        duration.value = parsed.duration ?? EMPTY.duration
        sort.value = parsed.sort ?? EMPTY.sort
        dateFrom.value = parsed.dateFrom ?? EMPTY.dateFrom
        dateTo.value = parsed.dateTo ?? EMPTY.dateTo
      } catch {
        // Corrupt value — reset silently.
      }
      loaded.value = true
      return
    }

    // First launch (or first launch under v3): seed the language filter
    // from the device locale and default the sort to oldest-first. We
    // persist immediately so subsequent reads take the regular branch
    // and the user's later changes overwrite the seed instead of racing
    // with it.
    const locale = await detectDeviceLocaleAsync()
    languageCodes.value = [locale]
    sort.value = "byDateAsc"
    loaded.value = true
    await persist()
  }

  async function persist(): Promise<void> {
    const payload: PersistedFilters = {
      authorIds: authorIds.value,
      languageCodes: languageCodes.value,
      locationIds: locationIds.value,
      sourceIds: sourceIds.value,
      tagIds: tagIds.value,
      topicIds: topicIds.value,
      duration: duration.value,
      sort: sort.value,
      dateFrom: dateFrom.value,
      dateTo: dateTo.value,
    }
    await app.preferences.set(STORAGE_KEY, JSON.stringify(payload))
  }

  async function setAuthors(ids: readonly string[]): Promise<void> {
    authorIds.value = ids
    await persist()
  }

  async function setLanguages(ids: readonly string[]): Promise<void> {
    languageCodes.value = ids
    await persist()
  }

  async function setLocations(ids: readonly string[]): Promise<void> {
    locationIds.value = ids
    await persist()
  }

  async function setSources(ids: readonly string[]): Promise<void> {
    sourceIds.value = ids
    await persist()
  }

  async function setTags(ids: readonly string[]): Promise<void> {
    tagIds.value = ids
    await persist()
  }

  async function setTopics(ids: readonly string[]): Promise<void> {
    topicIds.value = ids
    await persist()
  }

  async function setDuration(ids: readonly DurationFilterId[]): Promise<void> {
    duration.value = ids
    await persist()
  }

  async function setSort(value: PersistedFilters["sort"]): Promise<void> {
    sort.value = value
    await persist()
  }

  async function setDateFrom(value: string | undefined): Promise<void> {
    dateFrom.value = value
    await persist()
  }

  async function setDateTo(value: string | undefined): Promise<void> {
    dateTo.value = value
    await persist()
  }

  async function clearAll(): Promise<void> {
    authorIds.value = []
    languageCodes.value = []
    locationIds.value = []
    sourceIds.value = []
    tagIds.value = []
    topicIds.value = []
    duration.value = []
    sort.value = undefined
    dateFrom.value = undefined
    dateTo.value = undefined
    await persist()
  }

  /**
   * Drop in-memory state without writing to preferences. Used by the
   * Settings "Clear user data" flow, which has already wiped the
   * persisted snapshot via `app.preferences.remove(...)`. Calling
   * `clearAll()` there would re-create the key with an empty payload —
   * harmless but pointless write.
   */
  function reset(): void {
    authorIds.value = []
    languageCodes.value = []
    locationIds.value = []
    sourceIds.value = []
    tagIds.value = []
    topicIds.value = []
    duration.value = []
    sort.value = undefined
    dateFrom.value = undefined
    dateTo.value = undefined
    loaded.value = false
  }

  return {
    authorIds,
    languageCodes,
    locationIds,
    sourceIds,
    tagIds,
    topicIds,
    duration,
    sort,
    dateFrom,
    dateTo,
    loaded,
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

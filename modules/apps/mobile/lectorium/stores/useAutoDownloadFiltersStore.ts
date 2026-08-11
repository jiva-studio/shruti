import { defineStore } from "pinia"
import { ref } from "vue"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import { useLectorium } from "@lectorium/lectorium.js"

const STORAGE_KEY = "autoDownload.filters.v1"

export interface PersistedAutoDownloadFilters {
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

const EMPTY: PersistedAutoDownloadFilters = {
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
 * Filters that constrain the auto-download background loop. Mirrors the
 * shape of `useSearchFiltersStore` so the existing `SearchFiltersSheet`
 * UI can be reused, but persisted under a separate key — auto-download
 * is configured independently from manual search. Empty by default;
 * unlike the search store there is no first-launch seeding, because
 * "no filter" correctly means "the whole library is eligible".
 */
export const useAutoDownloadFiltersStore = defineStore("autoDownloadFilters", () => {
  const app = useLectorium()

  const authorIds = ref<readonly string[]>([])
  const languageCodes = ref<readonly string[]>([])
  const locationIds = ref<readonly string[]>([])
  const sourceIds = ref<readonly string[]>([])
  const tagIds = ref<readonly string[]>([])
  const topicIds = ref<readonly string[]>([])
  const duration = ref<readonly DurationFilterId[]>([])
  const sort = ref<PersistedAutoDownloadFilters["sort"]>(undefined)
  const dateFrom = ref<string | undefined>(undefined)
  const dateTo = ref<string | undefined>(undefined)
  const loaded = ref<boolean>(false)

  async function load(): Promise<void> {
    if (loaded.value) return
    const raw = await app.preferences.get(STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<PersistedAutoDownloadFilters>
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
    }
    loaded.value = true
  }

  async function persist(): Promise<void> {
    const payload: PersistedAutoDownloadFilters = {
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

  async function setSort(value: PersistedAutoDownloadFilters["sort"]): Promise<void> {
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

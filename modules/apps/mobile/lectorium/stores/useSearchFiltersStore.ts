import { defineStore } from "pinia"
import { ref } from "vue"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import { useLectorium } from "@lectorium/lectorium.js"

const STORAGE_KEY = "search.filters.v2"

export interface PersistedFilters {
  authorIds: readonly string[]
  languageCodes: readonly string[]
  locationIds: readonly string[]
  sourceIds: readonly string[]
  duration: readonly DurationFilterId[]
  sort: "byReference" | "byDate" | undefined
}

const EMPTY: PersistedFilters = {
  authorIds: [],
  languageCodes: [],
  locationIds: [],
  sourceIds: [],
  duration: [],
  sort: undefined,
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
  const duration = ref<readonly DurationFilterId[]>([])
  const sort = ref<PersistedFilters["sort"]>(undefined)
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
        duration.value = parsed.duration ?? EMPTY.duration
        sort.value = parsed.sort ?? EMPTY.sort
      } catch {
        // Corrupt value — reset silently.
      }
    }
    loaded.value = true
  }

  async function persist(): Promise<void> {
    const payload: PersistedFilters = {
      authorIds: authorIds.value,
      languageCodes: languageCodes.value,
      locationIds: locationIds.value,
      sourceIds: sourceIds.value,
      duration: duration.value,
      sort: sort.value,
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

  async function setDuration(ids: readonly DurationFilterId[]): Promise<void> {
    duration.value = ids
    await persist()
  }

  async function setSort(value: PersistedFilters["sort"]): Promise<void> {
    sort.value = value
    await persist()
  }

  async function clearAll(): Promise<void> {
    authorIds.value = []
    languageCodes.value = []
    locationIds.value = []
    sourceIds.value = []
    duration.value = []
    sort.value = undefined
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
    duration.value = []
    sort.value = undefined
    loaded.value = false
  }

  return {
    authorIds,
    languageCodes,
    locationIds,
    sourceIds,
    duration,
    sort,
    loaded,
    load,
    setAuthors,
    setLanguages,
    setLocations,
    setSources,
    setDuration,
    setSort,
    clearAll,
    reset,
  }
})

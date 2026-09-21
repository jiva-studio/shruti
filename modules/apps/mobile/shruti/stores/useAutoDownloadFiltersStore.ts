import { defineStore } from "pinia"
import { ref } from "vue"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import { useShruti } from "@shruti/shruti.js"
import { createFiltersState, parsePersistedFilters } from "./filters/persistedFilters.js"

const STORAGE_KEY = "autoDownload.filters.v1"

/**
 * Filters that constrain the auto-download background loop. Same shape as
 * `useSearchFiltersStore` so `SearchFiltersSheet` can be reused, but under a
 * separate key and with no first-launch seeding — for auto-download "no
 * filter" correctly means "the whole library is eligible".
 */
export const useAutoDownloadFiltersStore = defineStore("autoDownloadFilters", () => {
  const app = useShruti()
  const state = createFiltersState()
  const loaded = ref<boolean>(false)

  async function load(): Promise<void> {
    if (loaded.value) return
    const raw = await app.preferences.get(STORAGE_KEY)
    const stored = raw ? parsePersistedFilters(raw) : undefined
    if (stored) state.apply(stored)
    loaded.value = true
  }

  async function persist(): Promise<void> {
    await app.preferences.set(STORAGE_KEY, JSON.stringify(state.snapshot()))
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

import { ref, type Ref } from "vue"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"

/**
 * The filter tuple both the search and the auto-download store persist.
 *
 * `dateFrom` / `dateTo` are range edges — `"YYYY"` / `"YYYY-MM"`, or undefined
 * for an open end.
 */
export interface PersistedFilters {
  authorIds: readonly string[]
  languageCodes: readonly string[]
  locationIds: readonly string[]
  sourceIds: readonly string[]
  tagIds: readonly string[]
  topicIds: readonly string[]
  duration: readonly DurationFilterId[]
  sort: SortMethod | undefined
  dateFrom: string | undefined
  dateTo: string | undefined
}

export const EMPTY_FILTERS: PersistedFilters = {
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

/** Reads a stored payload, filling absent keys from `EMPTY_FILTERS`; undefined when the value is unusable. */
export function parsePersistedFilters(raw: string): PersistedFilters | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  // An array passes `typeof === "object"`, and merging one over the empty
  // filters yields a selection that looks deliberately blank.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined

  const stored = parsed as Record<string, unknown>
  const merged: Record<string, unknown> = { ...EMPTY_FILTERS }
  for (const key of Object.keys(EMPTY_FILTERS)) {
    const value = stored[key]
    if (value !== undefined && value !== null) merged[key] = value
  }
  return merged as unknown as PersistedFilters
}

export interface FiltersState {
  authorIds: Ref<readonly string[]>
  languageCodes: Ref<readonly string[]>
  locationIds: Ref<readonly string[]>
  sourceIds: Ref<readonly string[]>
  tagIds: Ref<readonly string[]>
  topicIds: Ref<readonly string[]>
  duration: Ref<readonly DurationFilterId[]>
  sort: Ref<SortMethod | undefined>
  dateFrom: Ref<string | undefined>
  dateTo: Ref<string | undefined>
  apply: (values: PersistedFilters) => void
  snapshot: () => PersistedFilters
  clear: () => void
}

/** The refs behind a filter store, plus conversion to and from the persisted tuple. */
export function createFiltersState(): FiltersState {
  const authorIds = ref<readonly string[]>([])
  const languageCodes = ref<readonly string[]>([])
  const locationIds = ref<readonly string[]>([])
  const sourceIds = ref<readonly string[]>([])
  const tagIds = ref<readonly string[]>([])
  const topicIds = ref<readonly string[]>([])
  const duration = ref<readonly DurationFilterId[]>([])
  const sort = ref<SortMethod | undefined>(undefined)
  const dateFrom = ref<string | undefined>(undefined)
  const dateTo = ref<string | undefined>(undefined)

  function apply(values: PersistedFilters): void {
    authorIds.value = values.authorIds
    languageCodes.value = values.languageCodes
    locationIds.value = values.locationIds
    sourceIds.value = values.sourceIds
    tagIds.value = values.tagIds
    topicIds.value = values.topicIds
    duration.value = values.duration
    sort.value = values.sort
    dateFrom.value = values.dateFrom
    dateTo.value = values.dateTo
  }

  function snapshot(): PersistedFilters {
    return {
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
  }

  function clear(): void {
    apply(EMPTY_FILTERS)
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
    apply,
    snapshot,
    clear,
  }
}

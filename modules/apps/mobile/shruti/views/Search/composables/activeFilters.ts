import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"

/** The list-valued dimensions of a `FiltersModel`, in section order. */
export const LIST_KEYS = ["authors", "languages", "locations", "sources", "tags", "topics"] as const

export type ListKey = (typeof LIST_KEYS)[number]

export interface ActiveFilterOptions {
  /** The locale-seeded library languages. A selection that is exactly these is
   *  the untouched default and does not count. */
  readonly seededLanguages?: readonly string[]
  /** The sort the store seeds on first launch; it does not count either. */
  readonly defaultSort?: string
}

/** Order-independent equality of two language-code lists. */
export function sameLanguageSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

function listSize(f: FiltersModel, key: ListKey): number {
  return f[key]?.length ?? 0
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== ""
}

function hasDates(f: FiltersModel): boolean {
  return f.dateFrom !== undefined || f.dateTo !== undefined
}

export function hasAnyFilter(f: FiltersModel): boolean {
  if (LIST_KEYS.some((key) => listSize(f, key) > 0)) return true
  return isSet(f.duration) || isSet(f.sort) || hasDates(f)
}

/** Number of active filter values across all dimensions — what the Filters
 *  badge shows. Seeded defaults are excluded so a pristine install reads 0. */
export function countActiveFilters(f: FiltersModel, options: ActiveFilterOptions = {}): number {
  const seeded = options.seededLanguages ?? []
  const langs = f.languages ?? []
  const isSeededDefault = seeded.length > 0 && sameLanguageSet(langs, seeded)
  const lists = LIST_KEYS.filter((key) => key !== "languages").reduce(
    (n, key) => n + listSize(f, key),
    isSeededDefault ? 0 : langs.length
  )
  const sortIsActive = isSet(f.sort) && f.sort !== options.defaultSort
  return lists + (isSet(f.duration) ? 1 : 0) + (sortIsActive ? 1 : 0) + (hasDates(f) ? 1 : 0)
}

/** Sections whose current value is a seeded default rather than a user choice. */
export function defaultFilterSections(
  f: FiltersModel,
  options: ActiveFilterOptions = {}
): ReadonlySet<string> {
  const seeded = options.seededLanguages ?? []
  const out = new Set<string>()
  if (seeded.length > 0 && sameLanguageSet(f.languages ?? [], seeded)) out.add("languages")
  if (!isSet(f.sort) || f.sort === options.defaultSort) out.add("sort")
  return out
}

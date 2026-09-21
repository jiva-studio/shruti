import { dateRangeBounds } from "@lib/domain/dateFilters.js"
import type { DiscoveryFilter } from "@lib/contracts"

export interface FacetInput {
  /** Author names as the current UI language spells them — what a person sees
   *  is what gets asked for, and the service resolves the archives' spellings. */
  readonly authors: readonly string[]
  readonly languages: readonly string[]
  /** English short codes ("SB", "CC Madhya"). The localized full name works in
   *  Russian and not in English, where the corpus writes diacritics no archive
   *  uses. */
  readonly sources: readonly string[]
  /** "YYYY" or "YYYY-MM". */
  readonly dateFrom?: string
  readonly dateTo?: string
}

/** The day before an exclusive upper bound, as `YYYY-MM-DD`. */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The app's facets in the vocabulary the service speaks. Locations, topics,
 * tags, duration and sort have no counterpart in the index and stay local to
 * the library lane.
 */
export function buildDiscoveryFilter(input: FacetInput): DiscoveryFilter {
  // The service wants whole ISO days, and its upper bound is inclusive where
  // dateRangeBounds' is not.
  const bounds = dateRangeBounds(input.dateFrom, input.dateTo)
  return {
    ...(input.authors.length ? { authors: [...input.authors] } : {}),
    ...(input.languages.length ? { languages: [...input.languages] } : {}),
    ...(input.sources.length ? { sources: [...input.sources] } : {}),
    ...(bounds.gte ? { date_from: bounds.gte } : {}),
    ...(bounds.lt ? { date_to: dayBefore(bounds.lt) } : {}),
  }
}

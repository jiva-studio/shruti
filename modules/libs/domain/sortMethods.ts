/**
 * UI constant: the small fixed set of sort orders the catalog supports.
 * Not a DB table.
 *
 * Tracks without a date (no `tracks.date`) or without a shloka
 * (no `track_variants.sort_reference` in this locale) are always sorted
 * last via SQL `NULLS LAST`, regardless of direction.
 */
export const SORT_METHODS = ["byDateDesc", "byDateAsc", "byReference"] as const
export type SortMethod = (typeof SORT_METHODS)[number]

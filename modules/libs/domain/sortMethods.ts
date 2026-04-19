/**
 * UI constant: the small fixed set of sort orders the catalog supports.
 * Not a DB table.
 */
export const SORT_METHODS = ["byDate", "byReference"] as const
export type SortMethod = (typeof SORT_METHODS)[number]

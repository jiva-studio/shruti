/** Case-insensitive substring match. Empty `needle` matches anything. */
export function containsCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
}

/** Show search field above the items list once at least this many items exist. */
export const SEARCH_VISIBILITY_THRESHOLD = 10

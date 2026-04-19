/**
 * Parses a reference-style search query such as "sb 1.8.40" or "bg 2.47"
 * into a list of tokens. Returns `null` for queries that don't look like
 * a reference (empty, all-non-alphanumeric, etc.) so the caller can fall
 * back to free-text title search.
 */
export function parseReferenceQuery(query: string): readonly string[] | null {
  const trimmed = query.trim()
  if (!trimmed) return null

  // Tokens: sequences of alphanumerics, split on whitespace / dot / dash / colon.
  const tokens = trimmed
    .toLowerCase()
    .split(/[\s.\-:]+/)
    .filter((t) => t.length > 0)

  if (tokens.length === 0) return null

  // Heuristic: a reference-looking query has at least one alphabetic token
  // (the scripture abbreviation) followed by at least one numeric token.
  const hasAlpha = tokens.some((t) => /^[a-z]+$/.test(t))
  const hasDigit = tokens.some((t) => /^\d+$/.test(t))
  if (!(hasAlpha && hasDigit)) return null

  return tokens
}

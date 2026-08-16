import type { Note } from "@lib/domain/note.js"

// A query has to scan the whole corpus before truncating, otherwise a
// match older than `limit` newest notes is never found. The note corpus
// is small (user-generated, device-local), so pulling it all is cheap.
export const SEARCH_CORPUS_CAP = 100_000

/** Default cap on the FILTERED result set (what the list renders). */
export const DEFAULT_SEARCH_LIMIT = 200

export interface NoteSearchResult {
  /** The matches to render — at most `limit` of them. */
  readonly matches: readonly Note[]
  /**
   * At least one further note matched past `limit`, so what the caller holds
   * is not the whole answer. Surfaced to the user: a silently capped list is
   * a note that "does not exist" until the query is narrowed (#1893).
   */
  readonly truncated: boolean
}

/**
 * Substring match over Note.text, case-insensitive, over an already-loaded
 * corpus. The fold is JS `toLowerCase`, which is Unicode-aware — SQLite's
 * `LIKE` only case-folds ASCII, so pushing this into SQL would quietly stop
 * "Кришна" from matching "кришна" in a corpus that is mostly Cyrillic.
 *
 * `limit` caps the FILTERED results, not the scanned corpus, so a match
 * older than the newest `limit` notes is still found. The scan still breaks
 * out at the cap — that is what keeps a one-letter query over a 100 000-note
 * corpus from building a huge array on every keystroke — it just collects one
 * match past it first, which is the whole cost of knowing that it truncated.
 */
export function searchNotes(
  notes: readonly Note[],
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT
): NoteSearchResult {
  const needle = query.trim().toLowerCase()
  if (!needle) return { matches: notes.slice(0, limit), truncated: notes.length > limit }
  const matches: Note[] = []
  for (const note of notes) {
    if (!note.text.toLowerCase().includes(needle)) continue
    matches.push(note)
    if (matches.length > limit) break
  }
  const truncated = matches.length > limit
  return { matches: truncated ? matches.slice(0, limit) : matches, truncated }
}

/** Matches only — for callers that don't render the "narrow your search" hint. */
export function filterNotes(
  notes: readonly Note[],
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT
): readonly Note[] {
  return searchNotes(notes, query, limit).matches
}

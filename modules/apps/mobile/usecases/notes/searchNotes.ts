import type { Note } from "@lib/domain/note.js"

// A query has to scan the whole corpus before truncating, otherwise a
// match older than `limit` newest notes is never found. The note corpus
// is small (user-generated, device-local), so pulling it all is cheap.
export const SEARCH_CORPUS_CAP = 100_000

/** Default cap on the FILTERED result set (what the list renders). */
export const DEFAULT_SEARCH_LIMIT = 200

/**
 * Substring match over Note.text, case-insensitive, over an already-loaded
 * corpus. The fold is JS `toLowerCase`, which is Unicode-aware — SQLite's
 * `LIKE` only case-folds ASCII, so pushing this into SQL would quietly stop
 * "Кришна" from matching "кришна" in a corpus that is mostly Cyrillic.
 *
 * `limit` caps the FILTERED results, not the scanned corpus, so a match
 * older than the newest `limit` notes is still found.
 */
export function filterNotes(
  notes: readonly Note[],
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT
): readonly Note[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return notes.slice(0, limit)
  const matches: Note[] = []
  for (const note of notes) {
    if (!note.text.toLowerCase().includes(needle)) continue
    matches.push(note)
    if (matches.length === limit) break
  }
  return matches
}

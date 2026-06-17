import type { Note } from "@lib/domain/note.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"

export interface SearchNotesInput {
  readonly query: string
  readonly limit?: number
}

export interface SearchNotesDeps {
  readonly notes: INoteRepository
}

// A query has to scan the whole corpus before truncating, otherwise a
// match older than `limit` newest notes is never found. The note corpus
// is small (user-generated, device-local), so pulling it all is cheap.
const SEARCH_CORPUS_CAP = 100_000

/**
 * Substring match over Note.text, case-insensitive. A thin wrapper around
 * listRecent — the note corpus is small (user-generated, device-local), so
 * a SQL LIKE isn't worth the coupling. An empty query returns the recent
 * list unfiltered, which is what the Notes view shows by default.
 *
 * When a query is present, `limit` caps the FILTERED results, not the
 * scanned corpus — we fetch the full corpus first so a match beyond the
 * recent window is still found, then slice the matches.
 */
export async function searchNotes(
  input: SearchNotesInput,
  deps: SearchNotesDeps
): Promise<readonly Note[]> {
  const limit = input.limit ?? 200
  const query = input.query.trim().toLowerCase()
  if (!query) return deps.notes.listRecent(limit)
  const all = await deps.notes.listRecent(SEARCH_CORPUS_CAP)
  return all.filter((n) => n.text.toLowerCase().includes(query)).slice(0, limit)
}

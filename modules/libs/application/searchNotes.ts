import type { Note } from "@lib/domain/note.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"

export interface SearchNotesInput {
  readonly query: string
  readonly limit?: number
}

export interface SearchNotesDeps {
  readonly notes: INoteRepository
}

/**
 * Substring match over Note.text, case-insensitive. A thin wrapper around
 * listRecent — the note corpus is small (user-generated, device-local), so
 * a SQL LIKE isn't worth the coupling. An empty query returns the recent
 * list unfiltered, which is what the Notes view shows by default.
 */
export async function searchNotes(
  input: SearchNotesInput,
  deps: SearchNotesDeps
): Promise<readonly Note[]> {
  const limit = input.limit ?? 200
  const all = await deps.notes.listRecent(limit)
  const query = input.query.trim().toLowerCase()
  if (!query) return all
  return all.filter((n) => n.text.toLowerCase().includes(query))
}

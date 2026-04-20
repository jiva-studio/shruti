import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"

export interface SearchTracksInput {
  readonly query: string
  readonly limit?: number
  readonly offset?: number
}

export interface SearchTracksDeps {
  readonly tracks: ITrackRepository
}

/**
 * Text search that covers both lecture titles and scripture references
 * in one call. The repository feeds the query into the unified
 * `tracks_search` FTS5 index, so there's no application-level branching
 * between "this looks like a reference" and "this looks like free text"
 * — the index already handles tokenisation for both.
 *
 * Language-of-variant is intentionally not a filter: a user typing a
 * Russian phrase should find Russian-titled tracks even if the UI
 * locale is English.
 */
export async function searchTracks(
  input: SearchTracksInput,
  deps: SearchTracksDeps
): Promise<readonly Track[]> {
  const trimmed = input.query.trim()
  if (!trimmed) return []
  return deps.tracks.search({
    text: trimmed,
    limit: input.limit,
    offset: input.offset,
  })
}

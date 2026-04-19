import type { LanguageCode } from "@lib/domain/core.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import { parseReferenceQuery } from "./parseReferenceQuery.js"

export interface SearchTracksInput {
  readonly query: string
  readonly preferredLanguage?: LanguageCode
  readonly limit?: number
  readonly offset?: number
}

export interface SearchTracksDeps {
  readonly tracks: ITrackRepository
}

/**
 * Decides between reference-based and free-text search based on the query
 * shape. Reference queries ("sb 1.8.40") match `track_references.token`
 * exactly; everything else is a case-insensitive title substring match.
 */
export async function searchTracks(
  input: SearchTracksInput,
  deps: SearchTracksDeps
): Promise<readonly Track[]> {
  const tokens = parseReferenceQuery(input.query)
  if (tokens) {
    return deps.tracks.search({
      referenceTokens: tokens,
      limit: input.limit,
      offset: input.offset,
    })
  }
  const trimmed = input.query.trim()
  if (!trimmed) return []
  return deps.tracks.search({
    text: trimmed,
    language: input.preferredLanguage,
    limit: input.limit,
    offset: input.offset,
  })
}

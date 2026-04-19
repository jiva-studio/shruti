import type { AuthorId, LanguageCode, LocationId, TagId, TrackId } from "../core.js"
import type { SortMethod } from "../sortMethods.js"
import type { Track } from "../track.js"

export interface TrackListFilters {
  readonly authorIds?: readonly AuthorId[]
  readonly locationIds?: readonly LocationId[]
  readonly languageCodes?: readonly LanguageCode[]
  readonly tagIds?: readonly TagId[]
  /** Filter by track duration (ms): inclusive-exclusive. */
  readonly durationMinMs?: number
  readonly durationMaxMs?: number
}

export interface TrackListQuery {
  readonly filters?: TrackListFilters
  readonly sortBy?: SortMethod
  readonly limit?: number
  readonly offset?: number
}

export interface TrackSearchQuery {
  /** Free-text query; matched case-insensitively as substring against titles. */
  readonly text?: string
  /** Reference tokens, e.g. ["sb", "1", "8", "40"]; matched exactly against track_references. */
  readonly referenceTokens?: readonly string[]
  readonly language?: LanguageCode
  readonly limit?: number
  readonly offset?: number
}

export interface ITrackRepository {
  getById(id: TrackId): Promise<Track | null>
  list(query: TrackListQuery): Promise<readonly Track[]>
  search(query: TrackSearchQuery): Promise<readonly Track[]>
}

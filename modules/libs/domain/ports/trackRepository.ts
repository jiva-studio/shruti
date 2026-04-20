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
  /**
   * Raw user query — a single string. The repo tokenises it via the
   * unified `tracks_search` FTS index, so the same query handles
   * titles ("Джентельмен") and references ("bg 10.5", "10.5").
   */
  readonly text?: string
  readonly limit?: number
  readonly offset?: number
}

export interface ITrackRepository {
  getById(id: TrackId): Promise<Track | null>
  list(query: TrackListQuery): Promise<readonly Track[]>
  search(query: TrackSearchQuery): Promise<readonly Track[]>

  /**
   * Returns the stored path (full bucket key, e.g.
   * `"public/tracks/xxx/transcripts/ru.json"`) of the transcript for a
   * given (track, language), or `null` when no transcript is advertised.
   * The path is consumed by transcript repositories — they resolve it to
   * an URL via `IStoragePublicUrl` without ever looking at SQL.
   */
  getTranscriptPath(trackId: TrackId, language: LanguageCode): Promise<string | null>

  /**
   * Languages for which the track has a transcript advertised.
   */
  listTranscriptLanguages(trackId: TrackId): Promise<readonly LanguageCode[]>
}

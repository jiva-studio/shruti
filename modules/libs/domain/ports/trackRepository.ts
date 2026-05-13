import type { AuthorId, LanguageCode, LocationId, SourceId, TagId, TrackId } from "../core.js"
import type { SortMethod } from "../sortMethods.js"
import type { Track } from "../track.js"

export interface TrackListFilters {
  readonly authorIds?: readonly AuthorId[]
  readonly locationIds?: readonly LocationId[]
  readonly languageCodes?: readonly LanguageCode[]
  readonly sourceIds?: readonly SourceId[]
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
  /**
   * Optional filters applied before scoring/pagination, so that
   * `limit`/`offset` count narrowed rows — not raw FTS matches.
   */
  readonly filters?: TrackListFilters
  readonly sortBy?: SortMethod
  readonly limit?: number
  readonly offset?: number
}

export interface ITrackRepository {
  getById(id: TrackId): Promise<Track | null>
  /**
   * Batch fetch — returns a map keyed by the requested ids so callers
   * can avoid N+1 round-trips when hydrating a playlist or similar.
   * Missing ids are simply absent from the map; the caller decides
   * whether that's an error.
   */
  getByIds(ids: readonly TrackId[]): Promise<ReadonlyMap<TrackId, Track>>
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

import type {
  AuthorId,
  LanguageCode,
  LocationId,
  SourceId,
  TagId,
  TopicId,
  TrackId,
} from "../core.js"
import type { SortMethod } from "../sortMethods.js"
import type { Track } from "../track.js"

export interface TrackListFilters {
  readonly authorIds?: readonly AuthorId[]
  readonly locationIds?: readonly LocationId[]
  readonly languageCodes?: readonly LanguageCode[]
  readonly sourceIds?: readonly SourceId[]
  readonly tagIds?: readonly TagId[]
  /** Filter by recommender topics: a track matches if it carries ANY (union). */
  readonly topicIds?: readonly TopicId[]
  /** Filter by track duration (ms): inclusive-exclusive. */
  readonly durationMinMs?: number
  readonly durationMaxMs?: number
  /** Filter by `tracks.date`: inclusive lower / exclusive upper, both
   *  `"YYYY-MM-DD"` strings. Either may be absent for an open-ended range. */
  readonly dateGte?: string
  readonly dateLt?: string
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
   * Total number of tracks matching `filters` (filter-only, no text
   * search), after the `hidden = 0` cut — i.e. the size of the set
   * `list()` would page through. Powers the "search among N lectures"
   * subtitle on the library search entry. Absent/empty filters count
   * the whole catalogue.
   */
  count(filters?: TrackListFilters): Promise<number>

  /**
   * Distinct calendar years present in the catalog (from `tracks.date`),
   * descending. Powers the year picker in the Search date-range filter so
   * it only offers years that actually have content.
   */
  listYears(): Promise<readonly number[]>

  /**
   * Lookup by an exact scripture reference — sourceId + dot-joined
   * tokens. Used by `proactive/rules/nextShloka.ts` to detect the
   * "next verse" track when the user just finished BG 2.13. Returns
   * the first track that has a `track_references` row matching the
   * pair, or `null` if no such track exists in the catalog.
   *
   * `languages` restricts the match to tracks that carry a variant in
   * one of the given content languages — so a Russian-library user is
   * never nudged toward an English-only lecture. Empty / omitted means
   * no language filter (any language), matching the "no library filter
   * set" convention used across the app.
   */
  findByReference(
    sourceId: SourceId,
    tokens: readonly string[],
    languages?: readonly LanguageCode[]
  ): Promise<Track | null>

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

  /**
   * Batch fetch max audio duration (ms) per track. Used by the chat
   * `UserContext` builder to express "I'm 73% through track X" as a
   * percent. Empty input returns an empty map. Tracks without any
   * variant duration are simply absent from the result map (caller
   * treats absent as "unknown").
   */
  getDurationsMs(trackIds: readonly TrackId[]): Promise<ReadonlyMap<TrackId, number>>

  /**
   * Batch fetch the byte size of the audio the app would actually
   * download per track — the preferred version (`clean` over `original`,
   * same rule as {@link pickPlayableAudio}) read from `track_audio`.
   * Backs the offline-storage budget. Tracks with no size on record are
   * absent from the map (caller treats absent as "unknown" and applies
   * its own estimate).
   *
   * Must NOT be served from the legacy `track_variants.audio_filesize`
   * column: it mirrors the ORIGINAL file, so for every track that has a
   * denoised version it reports a size we never download.
   */
  getAudioSizesBytes(trackIds: readonly TrackId[]): Promise<ReadonlyMap<TrackId, number>>
}

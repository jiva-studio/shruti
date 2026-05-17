import type { PlaylistItemId, TrackId, UnixMs } from "../core.js"
import type {
  DailyListeningTotal,
  ListeningSession,
  ListeningSessionId,
  TrackPositionSec,
} from "../listeningSession.js"

export interface ProgressEntry {
  readonly position: TrackPositionSec
  readonly updatedAtSec: number
}

/** One row of "what did the user recently listen to". Joins
 *  `listening_sessions` ⨝ `playlist_items` and folds the latest end-time
 *  + position per playlist item. Used to build the chat `UserContext`. */
export interface RecentTrackProgress {
  readonly trackId: TrackId
  /** Unix ms of the most recent session that touched this item. */
  readonly endedAtMs: UnixMs
  /** Last known `to_position` for the latest session, in seconds. */
  readonly positionSec: TrackPositionSec
}

export interface IListeningSessionRepository {
  /**
   * Open a new session that *continues* the item's listening history.
   * `from_position` is the previous session's `to_position` if any —
   * this is what makes background playback measurable on the next
   * resume tick. Returns the new session id.
   */
  start(args: { itemId: PlaylistItemId; position: TrackPositionSec }): Promise<ListeningSessionId>

  /**
   * Open a new session with `from_position = position`, ignoring the
   * previous session. Used when the player explicitly seeks — a seek
   * is a discontinuity, not continued listening.
   */
  forceStart(args: {
    itemId: PlaylistItemId
    position: TrackPositionSec
  }): Promise<ListeningSessionId>

  /** Update `ended_at = now` and `to_position = position` of an open session. */
  tick(id: ListeningSessionId, args: { position: TrackPositionSec }): Promise<void>

  /** Same as tick — semantically "the last update before closing". */
  finish(id: ListeningSessionId, args: { position: TrackPositionSec }): Promise<void>

  /** Most recent session for an item, by `ended_at`. Used to derive resume position. */
  getLastSessionForItem(itemId: PlaylistItemId): Promise<ListeningSession | null>

  /**
   * Batch resolve `to_position` of the latest session for each item id.
   * Used by the playlist to render progress rings without N+1 queries.
   */
  getProgressForItems(itemIds: readonly PlaylistItemId[]): Promise<Map<PlaylistItemId, ProgressEntry>>

  /**
   * For each item id, return `ended_at` (unix seconds) of the *most
   * recent* session whose `to_position >= duration - 2` (i.e. the last
   * time the track crossed the completion threshold). null means not
   * yet finished. Latest (not first) so that re-listening a completed
   * track resets time-based downstream behavior such as the
   * auto-archive sweep. `durations` is keyed by item id and expresses
   * seconds.
   */
  getCompletedAtForItems(
    itemIds: readonly PlaylistItemId[],
    durations: ReadonlyMap<PlaylistItemId, number>
  ): Promise<Map<PlaylistItemId, number | null>>

  /**
   * Sum `to_position - from_position` per local-timezone date, restricted
   * to sessions whose `ended_at` falls in `[fromMs, toMs)`. Input is
   * milliseconds for ergonomic interop with `Date.now()`.
   */
  getDailyTotals(fromMs: number, toMs: number): Promise<readonly DailyListeningTotal[]>

  /** Sum `to_position - from_position` across every session, in seconds. */
  getTotalListenedSeconds(): Promise<number>

  /**
   * Most-recent tracks with their last position, ordered by `ended_at`
   * DESC. One row per distinct playlist item (the GROUP BY collapses
   * sessions). Used by the chat composable to build the `recent_tracks`
   * field of the request's `UserContext`. Limit is small (typically 10);
   * the SQL adapter cleans up its IN-list size accordingly.
   */
  listRecentTracksWithProgress(limit: number): Promise<readonly RecentTrackProgress[]>
}

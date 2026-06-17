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

/** Total seconds listened on a single track within a time window, used
 *  by the weekly digest to list "what you listened to this week". Sums
 *  every session of every playlist item pointing at the track. */
export interface TrackListeningTotal {
  readonly trackId: TrackId
  /** Sum of `to_position - from_position` (clamped ≥ 0) in seconds. */
  readonly listenedSeconds: number
}

/** Seconds listened in one whole-day bucket, addressed by its 0-based
 *  offset from the window start rather than a calendar date. Powers the
 *  weekly-digest chart, whose columns step days from the same anchor. */
export interface DayOffsetListeningTotal {
  /** Whole days elapsed from the window's `fromMs` (0 = first day). */
  readonly dayOffset: number
  readonly listenedSeconds: number
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

  /**
   * Close a session with an explicit `ended_at` (unix seconds) instead of
   * "now". Used to split a session that spans local midnight: the
   * pre-midnight portion is closed at the last second of the old local day
   * so `getDailyTotals` (which groups by `date(ended_at, 'localtime')`)
   * credits it to that day, not the day the split was detected.
   */
  finishAt(
    id: ListeningSessionId,
    args: { position: TrackPositionSec; endedAtSec: number }
  ): Promise<void>

  /** Most recent session for an item, by `(ended_at, id)`. */
  getLastSessionForItem(itemId: PlaylistItemId): Promise<ListeningSession | null>

  /**
   * Resume position for one item: the *high-water mark* — the furthest
   * `to_position` ever reached across all of the item's sessions, not the
   * latest session's end. Rewinding (e.g. 40:00 → 5:00) and stopping must
   * not lose the user's place; resume returns the furthest point reached.
   * `null` when the item has no sessions. The caller still clamps against
   * duration, so a completed track's high-water mark resets to 0 on replay.
   */
  getResumePositionForItem(itemId: PlaylistItemId): Promise<TrackPositionSec | null>

  /**
   * Batch resolve the resume position (high-water mark — MAX `to_position`)
   * for each item id. Used by the playlist to render progress rings without
   * N+1 queries. `updatedAtSec` carries the latest `ended_at` for the item.
   */
  getProgressForItems(
    itemIds: readonly PlaylistItemId[]
  ): Promise<Map<PlaylistItemId, ProgressEntry>>

  /**
   * For each item id, decide completion from the *latest* session only.
   * Returns that session's `ended_at` (unix seconds) when its
   * `to_position >= duration - 2`, else null. Evaluating the latest
   * session (rather than "any session that ever crossed the threshold")
   * keeps completion consistent with the resume/progress position: after
   * the user replays a finished track and rewinds, the track becomes
   * in-progress again and is not re-archived until the latest session
   * reaches the threshold once more. `durations` is keyed by item id and
   * expresses seconds.
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

  /**
   * Sum `to_position - from_position` per whole-day bucket measured as the
   * integer day offset from `fromMs` (`floor((ended_at - fromMs) / 1 day)`),
   * restricted to `[fromMs, toMs)`. Unlike `getDailyTotals` this buckets by
   * pure epoch arithmetic from the window anchor instead of SQLite's
   * `localtime` calendar date, so the buckets always line up with a client
   * that steps days from the same `fromMs` regardless of the device's
   * timezone. Powers the weekly-digest chart.
   */
  getDailyTotalsByDayOffset(
    fromMs: number,
    toMs: number
  ): Promise<readonly DayOffsetListeningTotal[]>

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

  /**
   * Sum listened seconds per track for sessions whose `ended_at` falls in
   * `[fromMs, toMs)`, ordered by listened time DESC. Only tracks with > 0
   * seconds are returned. Input is milliseconds for interop with
   * `Date.now()`. Powers the weekly-digest "lectures you listened to"
   * list.
   */
  getTracksListenedInRange(fromMs: number, toMs: number): Promise<readonly TrackListeningTotal[]>

  /**
   * Wipe every session row. Used by the "delete account" / "clear user
   * data" flow — without this, listening progress and activity-heatmap
   * stats would survive a full account wipe because they live in their
   * own table separate from playlist_items.
   */
  clearAll(): Promise<void>
}

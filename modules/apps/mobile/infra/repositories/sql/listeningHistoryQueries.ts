import type { IDatabase } from "@ports/app/index.js"
import type { TrackId } from "@lib/domain/core.js"
import type { DailyListeningTotal } from "@lib/domain/listeningSession.js"
import type {
  DayOffsetListeningTotal,
  IListeningSessionRepository,
  RecentTrackProgress,
  TrackListeningTotal,
} from "@lib/domain/ports/listeningSessionRepository.js"

type HistoryQueries = Pick<
  IListeningSessionRepository,
  | "getTotalListenedSeconds"
  | "getDailyTotals"
  | "getDailyTotalsByDayOffset"
  | "listRecentTracksWithProgress"
  | "getTracksListenedInRange"
>

/** Corpus-wide rollups over the session log: totals, the activity heatmap and
 *  the recently-played row. */
export function createListeningHistoryQueries(db: IDatabase): HistoryQueries {
  return {
    async getTotalListenedSeconds(): Promise<number> {
      // Storm dedup: a pre-#1214 reentrancy race could flush hundreds of
      // zero-duration sessions at one instant, all sharing (item, started_at,
      // ended_at, from_position) and differing only in to_position — summed raw
      // they recount one slice hundreds of times. Collapse each such cluster to
      // MAX(to_position) first; a real session (replays included) never shares
      // that key. Outer MAX(0, …) still guards legacy negative-delta rows.
      const rows = await db.query<{ total: number | null }>(
        `SELECT SUM(MAX(0, mx_to - from_position)) AS total
           FROM (SELECT from_position, MAX(to_position) AS mx_to
                   FROM listening_sessions
                  GROUP BY item_id, started_at, ended_at, from_position)`
      )
      return Number(rows[0]?.total ?? 0)
    },

    async getDailyTotals(fromMs, toMs): Promise<readonly DailyListeningTotal[]> {
      const fromSec = Math.floor(fromMs / 1000)
      const toSec = Math.floor(toMs / 1000)
      // Storm dedup before bucketing — see getTotalListenedSeconds.
      const rows = await db.query<{ date: string; listened_seconds: number }>(
        `SELECT date(ended_at, 'unixepoch', 'localtime') AS date,
                SUM(MAX(0, mx_to - from_position)) AS listened_seconds
           FROM (SELECT ended_at, from_position, MAX(to_position) AS mx_to
                   FROM listening_sessions
                  WHERE ended_at >= ? AND ended_at < ?
                  GROUP BY item_id, started_at, ended_at, from_position)
          GROUP BY date
          ORDER BY date`,
        [fromSec, toSec]
      )
      return rows.map((r) => ({ date: r.date, listenedSeconds: Number(r.listened_seconds) }))
    },

    async getDailyTotalsByDayOffset(fromMs, toMs): Promise<readonly DayOffsetListeningTotal[]> {
      const fromSec = Math.floor(fromMs / 1000)
      const toSec = Math.floor(toMs / 1000)
      // Bucket by whole-day offset from the window anchor using plain epoch
      // arithmetic — NO `localtime`. `ended_at >= fromSec` keeps the dividend
      // non-negative so integer division floors. The client steps its chart
      // columns from the same `fromMs`, so offset `i` ↔ column `i` exactly,
      // regardless of the device timezone (`getDailyTotals`' local-date string
      // could disagree with the client's, dropping bars to zero).
      // Storm dedup before bucketing — see getTotalListenedSeconds.
      const rows = await db.query<{ day_offset: number; listened_seconds: number }>(
        `SELECT CAST((ended_at - ?) / 86400 AS INTEGER) AS day_offset,
                SUM(MAX(0, mx_to - from_position)) AS listened_seconds
           FROM (SELECT ended_at, from_position, MAX(to_position) AS mx_to
                   FROM listening_sessions
                  WHERE ended_at >= ? AND ended_at < ?
                  GROUP BY item_id, started_at, ended_at, from_position)
          GROUP BY day_offset
          ORDER BY day_offset`,
        [fromSec, fromSec, toSec]
      )
      return rows.map((r) => ({
        dayOffset: Number(r.day_offset),
        listenedSeconds: Number(r.listened_seconds),
      }))
    },

    async listRecentTracksWithProgress(limit: number): Promise<readonly RecentTrackProgress[]> {
      // GROUP BY playlist item collapses many sessions per track to one
      // row carrying the latest session's end time + to_position. JOIN
      // to playlist_items resolves the track_id (listening_sessions only
      // stores item_id). Sub-select for to_position is a correlated
      // lookup keyed on the latest end — exactly the value useChatStore
      // used to fetch inline.
      const rows = await db.query<{
        track_id: string
        ended_at: number
        position: number
      }>(
        `SELECT pi.track_id AS track_id,
                MAX(ls.ended_at) AS ended_at,
                (SELECT to_position FROM listening_sessions
                  WHERE item_id = ls.item_id
                  ORDER BY ended_at DESC, id DESC LIMIT 1) AS position
           FROM listening_sessions ls
           JOIN playlist_items pi ON pi.id = ls.item_id
          GROUP BY ls.item_id
          ORDER BY ended_at DESC
          LIMIT ?`,
        [limit]
      )
      return rows.map((r) => ({
        trackId: r.track_id as TrackId,
        endedAtMs: Number(r.ended_at) * 1000,
        positionSec: Number(r.position),
      }))
    },

    async getTracksListenedInRange(fromMs, toMs): Promise<readonly TrackListeningTotal[]> {
      const fromSec = Math.floor(fromMs / 1000)
      const toSec = Math.floor(toMs / 1000)
      // Storm dedup before the track join — see getTotalListenedSeconds.
      const rows = await db.query<{ track_id: string; listened_seconds: number }>(
        `SELECT pi.track_id AS track_id,
                SUM(MAX(0, d.mx_to - d.from_position)) AS listened_seconds
           FROM (SELECT item_id, from_position, MAX(to_position) AS mx_to
                   FROM listening_sessions
                  WHERE ended_at >= ? AND ended_at < ?
                  GROUP BY item_id, started_at, ended_at, from_position) d
           JOIN playlist_items pi ON pi.id = d.item_id
          GROUP BY pi.track_id
         HAVING listened_seconds > 0
          ORDER BY listened_seconds DESC`,
        [fromSec, toSec]
      )
      return rows.map((r) => ({
        trackId: r.track_id as TrackId,
        listenedSeconds: Number(r.listened_seconds),
      }))
    },
  }
}

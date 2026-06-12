import type { IDatabase } from "@ports/app/index.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import {
  COMPLETION_THRESHOLD_SEC,
  type DailyListeningTotal,
  type ListeningSession,
  type ListeningSessionId,
  type TrackPositionSec,
} from "@lib/domain/listeningSession.js"
import type {
  IListeningSessionRepository,
  ProgressEntry,
  RecentTrackProgress,
  TrackListeningTotal,
} from "@lib/domain/ports/listeningSessionRepository.js"
import type { ListeningSessionRow } from "@lib/persistence/user"
import { mutate, queryOne } from "@kit/persistence"
import { createIdGenerator } from "./idGenerator.js"
import { rowToListeningSession } from "./rowMappers.js"

const newSessionId = createIdGenerator("ls")

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function createSqlListeningSessionRepository(db: IDatabase): IListeningSessionRepository {
  async function lastToPositionForItem(itemId: PlaylistItemId): Promise<TrackPositionSec | null> {
    return queryOne<{ to_position: number }, TrackPositionSec>(
      db,
      "SELECT to_position FROM listening_sessions WHERE item_id = ? ORDER BY ended_at DESC LIMIT 1",
      [itemId],
      (r) => r.to_position
    )
  }

  async function insert(
    itemId: PlaylistItemId,
    fromPosition: TrackPositionSec,
    toPosition: TrackPositionSec
  ): Promise<ListeningSessionId> {
    const id = newSessionId()
    const t = nowSec()
    await mutate(
      db,
      `INSERT INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, itemId, t, t, fromPosition, toPosition]
    )
    return id
  }

  return {
    async start({ itemId, position }) {
      // `from_position` is where THIS listening interval begins. Resuming
      // forward from where we left off, the previous session's end is the
      // true start (the first progress frame may already be a beat ahead),
      // so we prefer `lastTo`. But when playback (re)starts BEFORE that mark
      // — replaying a finished lecture (resume resets to 0) or pressing play
      // after seeking back — `lastTo > position` would make `to - from`
      // negative and silently cancel the day's heatmap total. Clamp to
      // `position` so a session can never count negative time.
      const lastTo = await lastToPositionForItem(itemId)
      const fromPosition = Math.min(lastTo ?? position, position)
      return insert(itemId, fromPosition, position)
    },

    async forceStart({ itemId, position }) {
      return insert(itemId, position, position)
    },

    async tick(id, { position }) {
      await mutate(db, "UPDATE listening_sessions SET ended_at = ?, to_position = ? WHERE id = ?", [
        nowSec(),
        position,
        id,
      ])
    },

    async finish(id, { position }) {
      await mutate(db, "UPDATE listening_sessions SET ended_at = ?, to_position = ? WHERE id = ?", [
        nowSec(),
        position,
        id,
      ])
    },

    async getLastSessionForItem(itemId): Promise<ListeningSession | null> {
      return queryOne<ListeningSessionRow, ListeningSession>(
        db,
        "SELECT * FROM listening_sessions WHERE item_id = ? ORDER BY ended_at DESC LIMIT 1",
        [itemId],
        rowToListeningSession
      )
    },

    async getProgressForItems(itemIds) {
      const result = new Map<PlaylistItemId, ProgressEntry>()
      if (itemIds.length === 0) return result
      const placeholders = itemIds.map(() => "?").join(",")
      const rows = await db.query<{ item_id: string; to_position: number; ended_at: number }>(
        `SELECT outer_ls.item_id AS item_id,
                outer_ls.to_position AS to_position,
                outer_ls.ended_at AS ended_at
           FROM listening_sessions outer_ls
          WHERE outer_ls.item_id IN (${placeholders})
            AND outer_ls.ended_at = (
              SELECT MAX(inner_ls.ended_at)
                FROM listening_sessions inner_ls
               WHERE inner_ls.item_id = outer_ls.item_id
            )`,
        [...itemIds]
      )
      for (const row of rows) {
        result.set(row.item_id, { position: row.to_position, updatedAtSec: row.ended_at })
      }
      return result
    },

    async getCompletedAtForItems(itemIds, durations) {
      const result = new Map<PlaylistItemId, number | null>()
      for (const id of itemIds) result.set(id, null)
      if (itemIds.length === 0) return result
      // For each (itemId, threshold = duration - COMPLETION_THRESHOLD_SEC),
      // find the latest session.ended_at where to_position >= threshold.
      // Latest (not earliest) so that re-listening a completed track
      // resets the auto-archive clock — otherwise an "immediate" sweep
      // would archive a track the user just finished replaying.
      // We iterate per item to keep the SQL simple — itemIds is bounded by
      // playlist page size, so it's cheap.
      for (const itemId of itemIds) {
        const dur = durations.get(itemId)
        if (typeof dur !== "number" || dur <= 0) continue
        const threshold = Math.max(0, dur - COMPLETION_THRESHOLD_SEC)
        const rows = await db.query<{ ended_at: number }>(
          `SELECT ended_at FROM listening_sessions
            WHERE item_id = ? AND to_position >= ?
            ORDER BY ended_at DESC
            LIMIT 1`,
          [itemId, threshold]
        )
        if (rows[0]) result.set(itemId, rows[0].ended_at)
      }
      return result
    },

    async getTotalListenedSeconds(): Promise<number> {
      // MAX(0, …) per row so any legacy negative-delta sessions (written
      // before the `start()` clamp) can't drag the total below the truth.
      const rows = await db.query<{ total: number | null }>(
        "SELECT SUM(MAX(0, to_position - from_position)) AS total FROM listening_sessions"
      )
      return Number(rows[0]?.total ?? 0)
    },

    async getDailyTotals(fromMs, toMs): Promise<readonly DailyListeningTotal[]> {
      const fromSec = Math.floor(fromMs / 1000)
      const toSec = Math.floor(toMs / 1000)
      const rows = await db.query<{ date: string; listened_seconds: number }>(
        `SELECT date(ended_at, 'unixepoch', 'localtime') AS date,
                SUM(MAX(0, to_position - from_position)) AS listened_seconds
           FROM listening_sessions
          WHERE ended_at >= ? AND ended_at < ?
          GROUP BY date
          ORDER BY date`,
        [fromSec, toSec]
      )
      return rows.map((r) => ({ date: r.date, listenedSeconds: Number(r.listened_seconds) }))
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
                  ORDER BY ended_at DESC LIMIT 1) AS position
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
      const rows = await db.query<{ track_id: string; listened_seconds: number }>(
        `SELECT pi.track_id AS track_id,
                SUM(MAX(0, ls.to_position - ls.from_position)) AS listened_seconds
           FROM listening_sessions ls
           JOIN playlist_items pi ON pi.id = ls.item_id
          WHERE ls.ended_at >= ? AND ls.ended_at < ?
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

    async clearAll(): Promise<void> {
      await mutate(db, "DELETE FROM listening_sessions")
    },
  }
}

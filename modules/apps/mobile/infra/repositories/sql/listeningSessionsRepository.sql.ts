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
  DayOffsetListeningTotal,
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

// Bound on `?` parameters in one statement. SQLite's own limit is 999 on
// builds older than 3.32 (still shipped by some Android system libraries),
// so keep a margin below it and chunk anything larger.
const ID_CHUNK_SIZE = 500

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

export function createSqlListeningSessionRepository(db: IDatabase): IListeningSessionRepository {
  async function lastToPositionForItem(itemId: PlaylistItemId): Promise<TrackPositionSec | null> {
    // `id DESC` is a deterministic tiebreak: `ended_at` has whole-second
    // resolution, so two sessions closed in the same second would otherwise
    // pick an arbitrary row.
    return queryOne<{ to_position: number }, TrackPositionSec>(
      db,
      "SELECT to_position FROM listening_sessions WHERE item_id = ? ORDER BY ended_at DESC, id DESC LIMIT 1",
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
      // `to_position` is monotonic non-decreasing WITHIN a session: a backward
      // position event — a fast scrub or an out-of-order player tick that
      // bypassed `seek()` — must not rewind `to` below `from` and manufacture a
      // negative `to - from` delta. `MAX(to_position, ?)` keeps the high-water
      // mark and preserves real forward progress; a genuine backward jump is a
      // seek and opens its own session via `seek()`.
      await mutate(
        db,
        "UPDATE listening_sessions SET ended_at = ?, to_position = MAX(to_position, ?) WHERE id = ?",
        [nowSec(), position, id]
      )
    },

    async finish(id, { position }) {
      // Same monotonic guard as tick(): a finish landing below where the
      // session already reached keeps the high-water mark, so a session can
      // never persist a negative delta. See tick() for the rationale.
      await mutate(
        db,
        "UPDATE listening_sessions SET ended_at = ?, to_position = MAX(to_position, ?) WHERE id = ?",
        [nowSec(), position, id]
      )
    },

    async finishAt(id, { position, endedAtSec }) {
      await mutate(db, "UPDATE listening_sessions SET ended_at = ?, to_position = ? WHERE id = ?", [
        endedAtSec,
        position,
        id,
      ])
    },

    async getLastSessionForItem(itemId): Promise<ListeningSession | null> {
      // `id DESC` deterministically breaks whole-second `ended_at` ties.
      return queryOne<ListeningSessionRow, ListeningSession>(
        db,
        "SELECT * FROM listening_sessions WHERE item_id = ? ORDER BY ended_at DESC, id DESC LIMIT 1",
        [itemId],
        rowToListeningSession
      )
    },

    async getResumePositionForItem(itemId): Promise<TrackPositionSec | null> {
      // High-water mark: the furthest point ever reached, NOT the latest
      // session's end. Rewinding then stopping must not throw away progress.
      return queryOne<{ hwm: number | null }, TrackPositionSec | null>(
        db,
        "SELECT MAX(to_position) AS hwm FROM listening_sessions WHERE item_id = ?",
        [itemId],
        (r) => r.hwm
      )
    },

    async getProgressForItems(itemIds) {
      const result = new Map<PlaylistItemId, ProgressEntry>()
      if (itemIds.length === 0) return result
      const placeholders = itemIds.map(() => "?").join(",")
      // `position` is the high-water mark (MAX to_position) so the resume
      // ring never rewinds when the user seeks back and stops; `updatedAtSec`
      // is the item's latest `ended_at` for any recency display.
      const rows = await db.query<{ item_id: string; to_position: number; ended_at: number }>(
        `SELECT item_id AS item_id,
                MAX(to_position) AS to_position,
                MAX(ended_at) AS ended_at
           FROM listening_sessions
          WHERE item_id IN (${placeholders})
          GROUP BY item_id`,
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
      // Completion is decided from the *latest* session only, so it stays
      // consistent with the resume/progress position. Take the latest
      // session (by `ended_at`, `id` as a deterministic tiebreak) and report
      // it completed only when ITS `to_position >= duration - threshold`.
      // This makes a replayed-then-rewound track in-progress again (no
      // partial-radial-yet-archive-eligible divergence) and resets the
      // auto-archive clock until the latest session crosses the threshold.
      //
      // One query per chunk of ids, never one per item: callers pass the
      // whole active + archived union (playlist store, activity overview,
      // auto-archive sweep), which has no page bound and grows with every
      // item ever added. `NOT EXISTS` picks that single latest row per item
      // with the same `ended_at`/`id` tiebreak the per-item read used, and
      // rides the `(item_id, ended_at DESC)` index. The per-item duration
      // threshold is applied in TS, so the SQL stays parameter-free beyond
      // the ids.
      const wanted = [...new Set(itemIds)].filter((id) => {
        const dur = durations.get(id)
        return typeof dur === "number" && dur > 0
      })
      for (const chunk of chunked(wanted, ID_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => "?").join(",")
        const rows = await db.query<{ item_id: string; ended_at: number; to_position: number }>(
          `SELECT s.item_id AS item_id, s.ended_at AS ended_at, s.to_position AS to_position
             FROM listening_sessions s
            WHERE s.item_id IN (${placeholders})
              AND NOT EXISTS (
                    SELECT 1 FROM listening_sessions t
                     WHERE t.item_id = s.item_id
                       AND (t.ended_at > s.ended_at
                            OR (t.ended_at = s.ended_at AND t.id > s.id)))`,
          [...chunk]
        )
        for (const row of rows) {
          const dur = durations.get(row.item_id)
          if (typeof dur !== "number" || dur <= 0) continue
          const threshold = Math.max(0, dur - COMPLETION_THRESHOLD_SEC)
          if (row.to_position >= threshold) result.set(row.item_id, row.ended_at)
        }
      }
      return result
    },

    async hasAny(): Promise<boolean> {
      const rows = await db.query<{ one: number }>(
        "SELECT 1 AS one FROM listening_sessions LIMIT 1"
      )
      return rows.length > 0
    },

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

    async clearAll(): Promise<void> {
      await mutate(db, "DELETE FROM listening_sessions")
    },
  }
}

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
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { ListeningSessionRow } from "@lib/persistence/user"
import { mutate, queryOne } from "@kit/persistence"
import { createIdGenerator } from "./idGenerator.js"
import { rowToListeningSession } from "./rowMappers.js"

const newSessionId = createIdGenerator("ls")

// Bound on `?` parameters in one statement. The bundled builds we actually
// ship (sql.js, the SQLite inside @capacitor-community/sqlite v8) allow
// 32766, but the pre-3.32 limit of 999 is cheap to stay under, so chunk.
const ID_CHUNK_SIZE = 500

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Restricts a session scan to the item's **current pass** — the listening it
 * has accumulated since it was last added to the playlist.
 *
 * A pass used to be delimited by the row itself: archiving left the row alone
 * and re-adding INSERTed a second one, so the fresh item id had no history by
 * construction, which is what made a re-added lecture read as unlistened on
 * Home (LECTORIUM-18/19). `playlist_items` now holds one row per `track_id`
 * (migration 027) and a re-add resurrects it with a new `added_at`, so the
 * boundary has to be read off `added_at` instead of inferred from an id that
 * no longer churns.
 *
 * `added_at` is unix MILLIseconds, `ended_at` unix seconds.
 *
 * LEFT JOIN, and NULL-tolerant: a session can be keyed on an item id that has
 * no playlist row — playback outside the playlist writes a synthetic
 * `track:<id>` item id (`playTrack.ts`), and removing an item leaves its
 * sessions behind. Those have no pass boundary to speak of, so they stay in
 * scope exactly as before.
 */
const CURRENT_PASS = {
  join: "LEFT JOIN playlist_items pass_item ON pass_item.id = ls.item_id",
  where: "(pass_item.added_at IS NULL OR ls.ended_at >= pass_item.added_at / 1000)",
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/**
 * Every write goes through the injected {@link IUnitOfWork} rather than a bare
 * `mutate`.
 *
 * `mutate` is `execute` + `save`, and `execute` deliberately bypasses the
 * adapters' transaction queue (repos call it from inside a transaction
 * callback, so queueing it would dead-lock — see
 * `useCapacitorSqlPersistence.ts`). The consequence is that a bare write
 * issued while an unrelated transaction is open joins that transaction on the
 * single shared connection and is discarded when it rolls back (#1494). This
 * repository is the one that makes that routine: `forceStart` and `tick` fire
 * off the player's progress cadence, i.e. on a timer, straight through a sync
 * pull's transaction window — and on sql.js the rollback also drops the
 * deferred `save()`, so the write reaches neither the database nor IndexedDB.
 *
 * Routing them through the unit of work puts each one in the adapter's
 * transaction queue instead, so it waits for the foreign block and commits in
 * a transaction of its own. `finish` / `finishAt` are additionally called by
 * the sync-journal decorator from inside ITS transaction; they take that
 * transaction's handle and join it, keeping the row and its outbox entry
 * atomic.
 */
export function createSqlListeningSessionRepository(
  db: IDatabase,
  unitOfWork: IUnitOfWork
): IListeningSessionRepository {
  async function lastToPositionForItem(itemId: PlaylistItemId): Promise<TrackPositionSec | null> {
    // `id DESC` is a deterministic tiebreak: `ended_at` has whole-second
    // resolution, so two sessions closed in the same second would otherwise
    // pick an arbitrary row.
    return queryOne<{ to_position: number }, TrackPositionSec>(
      db,
      `SELECT ls.to_position AS to_position
         FROM listening_sessions ls ${CURRENT_PASS.join}
        WHERE ls.item_id = ? AND ${CURRENT_PASS.where}
        ORDER BY ls.ended_at DESC, ls.id DESC LIMIT 1`,
      [itemId],
      (r) => r.to_position
    )
  }

  /**
   * Highest `to_position` among the item's sessions that CLOSED inside
   * `[fromSec, toSec]`. Deliberately time-scoped: it answers "did a live row
   * already claim part of THIS playback run?", which the item's all-time mark
   * cannot — that one also matches a listen from weeks ago and would zero out
   * a legitimate re-listen.
   *
   * `MAX`, not the latest row: one run can leave several (a seek splits the
   * session, so does a midnight roll), and the furthest of them is the mark
   * a journal row must not reach back behind.
   */
  async function claimedInWindow(
    itemId: PlaylistItemId,
    fromSec: number,
    toSec: number
  ): Promise<TrackPositionSec | null> {
    return queryOne<{ hwm: number | null }, TrackPositionSec | null>(
      db,
      `SELECT MAX(to_position) AS hwm FROM listening_sessions
        WHERE item_id = ? AND ended_at >= ? AND ended_at <= ?`,
      [itemId, fromSec, toSec],
      (r) => r.hwm
    )
  }

  async function insert(
    itemId: PlaylistItemId,
    fromPosition: TrackPositionSec,
    toPosition: TrackPositionSec,
    sourceKey: string | null = null
  ): Promise<ListeningSessionId> {
    const id = newSessionId()
    const t = nowSec()
    await mutate(
      db,
      `INSERT INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, itemId, t, t, fromPosition, toPosition, sourceKey]
    )
    return id
  }

  return {
    async start({ itemId, position }, tx) {
      // `from_position` is where THIS listening interval begins. Resuming
      // forward from where we left off, the previous session's end is the
      // true start (the first progress frame may already be a beat ahead),
      // so we prefer `lastTo`. But when playback (re)starts BEFORE that mark
      // — replaying a finished lecture (resume resets to 0) or pressing play
      // after seeking back — `lastTo > position` would make `to - from`
      // negative and silently cancel the day's heatmap total. Clamp to
      // `position` so a session can never count negative time.
      // Read-then-insert: one transaction so a concurrent writer can't slip
      // between the high-water read and the row it decides.
      return unitOfWork.run(async () => {
        const lastTo = await lastToPositionForItem(itemId)
        const fromPosition = Math.min(lastTo ?? position, position)
        return insert(itemId, fromPosition, position)
      }, tx)
    },

    async forceStart({ itemId, position }, tx) {
      return unitOfWork.run(() => insert(itemId, position, position), tx)
    },

    async forceStartOnce({ itemId, position, endPosition, sourceKey, runWindow }) {
      // The native journal reports a finished item as `[resume point → end]`
      // and knows nothing about the live tracker, which has usually already
      // written the foreground prefix of exactly that span. Raise `from` to
      // whatever a live row of the SAME run already claimed, so the two can't
      // both count it (#1623).
      //
      // The clamp is scoped to the run's wall-clock window, NOT the item's
      // all-time mark: a lecture re-listened weeks later leaves no row inside
      // the window, so it is credited in full. Clamping on position alone
      // would zero it out — and for an already-completed lecture that is the
      // same case the `completedAt` filter drops in #1596, so it would die
      // twice over.
      //
      // Read-then-insert inside one transaction, as in `start()`: the live
      // tracker writes on the player's tick cadence, straight through this
      // drain's window.
      return unitOfWork.run(async () => {
        // Read first so a replay inserts nothing rather than raising a caught
        // constraint violation; the UNIQUE index (migration 025) still stands
        // behind it as the guarantee, and turns a genuine race into a throw the
        // caller reports instead of a silently doubled total.
        //
        // The existing id is handed back, not swallowed: the key is stamped by
        // the INSERT, so a row whose `finish` never landed sits on disk at zero
        // seconds and the replay is the only thing that can still close it
        // (#1593).
        const existing = await queryOne<{ id: string }, ListeningSessionId>(
          db,
          "SELECT id FROM listening_sessions WHERE source_key = ? LIMIT 1",
          [sourceKey],
          (r) => r.id as ListeningSessionId
        )
        if (existing !== null) return { id: existing, created: false }
        // Capped at `endPosition`, because the clamp may only shrink this run's
        // interval from the LEFT — never push its start past where the run
        // actually ended. Uncapped, a rewind-then-skip (the live row closed
        // near the end, this run finished a minute in) lands the row at
        // `from == to ==` that earlier high-water, and since completion is read
        // off the LATEST session the lecture the user had just rewound reads as
        // finished — the Smart Library sweep then archives it and deletes its
        // audio (#1662). Capping keeps `to >= from`, the invariant `start` /
        // `tick` / `finish` all maintain, so the row credits zero instead.
        const claimed = await claimedInWindow(itemId, runWindow.fromSec, runWindow.toSec)
        const fromPosition = Math.min(Math.max(claimed ?? position, position), endPosition)
        const id = await insert(itemId, fromPosition, fromPosition, sourceKey)
        return { id, created: true }
      })
    },

    async tick(id, { position }, tx) {
      // `to_position` is monotonic non-decreasing WITHIN a session: a backward
      // position event — a fast scrub or an out-of-order player tick that
      // bypassed `seek()` — must not rewind `to` below `from` and manufacture a
      // negative `to - from` delta. `MAX(to_position, ?)` keeps the high-water
      // mark and preserves real forward progress; a genuine backward jump is a
      // seek and opens its own session via `seek()`.
      await unitOfWork.run(
        () =>
          mutate(
            db,
            "UPDATE listening_sessions SET ended_at = ?, to_position = MAX(to_position, ?) WHERE id = ?",
            [nowSec(), position, id]
          ),
        tx
      )
    },

    async finish(id, { position }, tx) {
      // Same monotonic guard as tick(): a finish landing below where the
      // session already reached keeps the high-water mark, so a session can
      // never persist a negative delta. See tick() for the rationale.
      await unitOfWork.run(
        () =>
          mutate(
            db,
            "UPDATE listening_sessions SET ended_at = ?, to_position = MAX(to_position, ?) WHERE id = ?",
            [nowSec(), position, id]
          ),
        tx
      )
    },

    async finishAt(id, { position, endedAtSec }, tx) {
      await unitOfWork.run(
        () =>
          mutate(db, "UPDATE listening_sessions SET ended_at = ?, to_position = ? WHERE id = ?", [
            endedAtSec,
            position,
            id,
          ]),
        tx
      )
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
      // High-water mark of the CURRENT PASS, NOT the latest session's end.
      // Rewinding then stopping must not throw away progress; re-adding the
      // lecture must, because that is the user asking to hear it again.
      return queryOne<{ hwm: number | null }, TrackPositionSec | null>(
        db,
        `SELECT MAX(ls.to_position) AS hwm
           FROM listening_sessions ls ${CURRENT_PASS.join}
          WHERE ls.item_id = ? AND ${CURRENT_PASS.where}`,
        [itemId],
        (r) => r.hwm
      )
    },

    async getProgressForItems(itemIds) {
      const result = new Map<PlaylistItemId, ProgressEntry>()
      if (itemIds.length === 0) return result
      // Chunked like `getCompletedAtForItems` below, and for the same reason:
      // the playlist store now asks for the whole active list at `refresh()`
      // (#1850), not the ≤50 of a rendered page, and one flat `IN (?,?,…)`
      // over a thousand-item queue overruns SQLite's parameter limit.
      for (const chunk of chunked(itemIds, ID_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => "?").join(",")
        // `position` is the high-water mark (MAX to_position) so the resume
        // ring never rewinds when the user seeks back and stops; `updatedAtSec`
        // is the item's latest `ended_at` for any recency display.
        const rows = await db.query<{ item_id: string; to_position: number; ended_at: number }>(
          `SELECT ls.item_id AS item_id,
                  MAX(ls.to_position) AS to_position,
                  MAX(ls.ended_at) AS ended_at
             FROM listening_sessions ls ${CURRENT_PASS.join}
            WHERE ls.item_id IN (${placeholders}) AND ${CURRENT_PASS.where}
            GROUP BY ls.item_id`,
          chunk
        )
        for (const row of rows) {
          result.set(row.item_id, { position: row.to_position, updatedAtSec: row.ended_at })
        }
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
      // item ever added.
      //
      // The ids ride in as a `VALUES` list and drive the per-item read
      // VERBATIM — same `ORDER BY ended_at DESC, id DESC LIMIT 1`, so the
      // tiebreak keeps SQLite's collation instead of JS string ordering and
      // the plan per item is the same index seek the loop did. That makes
      // cost flat in sessions-per-item, which matters because sessions are
      // never pruned (migration 016 leaves finished storm rows in place),
      // so that count only grows.
      //
      // Two tempting formulations are NOT flat, both measurably slower than
      // the per-item loop once sessions pile up:
      //   - `NOT EXISTS (… t.ended_at > s.ended_at OR (… t.id > s.id))` —
      //     the OR defeats the range seek, so each of an item's rows
      //     rescans the whole item (quadratic).
      //   - joining against a `GROUP BY item_id` + `MAX(ended_at)` subquery
      //     — SQLite's min/max index shortcut does not apply under GROUP BY,
      //     so it walks every index entry of every group (linear).
      const wanted = [...new Set(itemIds)].filter((id) => {
        const dur = durations.get(id)
        return typeof dur === "number" && dur > 0
      })
      for (const chunk of chunked(wanted, ID_CHUNK_SIZE)) {
        const values = chunk.map(() => "(?)").join(",")
        const rows = await db.query<{ item_id: string; ended_at: number; to_position: number }>(
          `WITH ids(item_id) AS (VALUES ${values})
           SELECT s.item_id AS item_id, s.ended_at AS ended_at, s.to_position AS to_position
             FROM ids
             JOIN listening_sessions s
               ON s.id = (SELECT ls.id FROM listening_sessions ls ${CURRENT_PASS.join}
                           WHERE ls.item_id = ids.item_id AND ${CURRENT_PASS.where}
                           ORDER BY ls.ended_at DESC, ls.id DESC
                           LIMIT 1)`,
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

    async listEverCompletedItems(itemIds, durations) {
      const result = new Set<PlaylistItemId>()
      if (itemIds.length === 0) return result
      // Lifetime, so NOT pass-scoped and NOT read off the latest session: the
      // question is whether the item's listening EVER reached the end, which
      // makes it monotonic — it survives a rewind, an archive and a re-add.
      // `MAX(to_position)` over every session of the item answers exactly that
      // in one grouped index scan.
      const wanted = [...new Set(itemIds)].filter((id) => {
        const dur = durations.get(id)
        return typeof dur === "number" && dur > 0
      })
      for (const chunk of chunked(wanted, ID_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => "?").join(",")
        const rows = await db.query<{ item_id: string; hwm: number }>(
          `SELECT item_id AS item_id, MAX(to_position) AS hwm
             FROM listening_sessions
            WHERE item_id IN (${placeholders})
            GROUP BY item_id`,
          [...chunk]
        )
        for (const row of rows) {
          const dur = durations.get(row.item_id)
          if (typeof dur !== "number" || dur <= 0) continue
          if (row.hwm >= Math.max(0, dur - COMPLETION_THRESHOLD_SEC)) result.add(row.item_id)
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

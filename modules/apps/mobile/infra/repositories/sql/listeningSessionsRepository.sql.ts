import type { IDatabase } from "@ports/app/index.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import type {
  ListeningSession,
  ListeningSessionId,
  TrackPositionSec,
} from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { ListeningSessionRow } from "@lib/persistence/user"
import { mutate, queryOne } from "@kit/persistence"
import { createIdGenerator } from "./idGenerator.js"
import { rowToListeningSession } from "./rowMappers.js"
import { CURRENT_PASS } from "./listeningQueryFragments.js"
import { createListeningHistoryQueries } from "./listeningHistoryQueries.js"
import { createListeningProgressQueries } from "./listeningProgressQueries.js"

const newSessionId = createIdGenerator("ls")

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Every write goes through the injected {@link IUnitOfWork} rather than a bare
 * `mutate`.
 *
 * `mutate` is `execute` + `save`, and `execute` deliberately bypasses the
 * adapters' transaction queue, so a bare write issued while an unrelated
 * transaction is open joins it on the single shared connection and is
 * discarded when it rolls back. `forceStart` and `tick` fire off the player's
 * progress cadence, i.e. on a timer, straight through a sync pull's
 * transaction window. Routing them through the unit of work queues each one
 * instead, so it waits for the foreign block and commits on its own.
 *
 * `finish` / `finishAt` are additionally called by the sync-journal decorator
 * from inside ITS transaction; they take that handle and join it, keeping the
 * row and its outbox entry atomic.
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
      // both count it.
      //
      // The clamp is scoped to the run's wall-clock window, NOT the item's
      // all-time mark: a lecture re-listened weeks later leaves no row inside
      // the window, so it is credited in full.
      //
      // Read-then-insert inside one transaction, as in `start()`: the live
      // tracker writes on the player's tick cadence, straight through this
      // drain's window.
      return unitOfWork.run(async () => {
        // Read first so a replay inserts nothing rather than raising a caught
        // constraint violation; the UNIQUE index still stands behind it and
        // turns a genuine race into a throw the caller reports.
        //
        // The existing id is handed back, not swallowed: a row whose `finish`
        // never landed sits on disk at zero seconds, and the replay is the
        // only thing that can still close it.
        const existing = await queryOne<{ id: string }, ListeningSessionId>(
          db,
          "SELECT id FROM listening_sessions WHERE source_key = ? LIMIT 1",
          [sourceKey],
          (r) => r.id as ListeningSessionId
        )
        if (existing !== null) return { id: existing, created: false }
        // Capped at `endPosition`, because the clamp may only shrink this run's
        // interval from the LEFT — never push its start past where the run
        // actually ended. Capping keeps `to >= from`, the invariant `start` /
        // `tick` / `finish` all maintain, so the row credits zero instead;
        // uncapped, a rewind-then-skip reads as a finished lecture, which the
        // Smart Library sweep archives.
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
      // session already reached keeps the high-water mark.
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

    ...createListeningProgressQueries(db),
    ...createListeningHistoryQueries(db),

    async hasAny(): Promise<boolean> {
      const rows = await db.query<{ one: number }>(
        "SELECT 1 AS one FROM listening_sessions LIMIT 1"
      )
      return rows.length > 0
    },

    async clearAll(): Promise<void> {
      await mutate(db, "DELETE FROM listening_sessions")
    },
  }
}

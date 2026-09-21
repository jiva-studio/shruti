import type { IDatabase } from "@ports/app/index.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { COMPLETION_THRESHOLD_SEC } from "@lib/domain/listeningSession.js"
import type {
  IListeningSessionRepository,
  ProgressEntry,
} from "@lib/domain/ports/listeningSessionRepository.js"
import { chunked, CURRENT_PASS, ID_CHUNK_SIZE } from "./listeningQueryFragments.js"

type ProgressQueries = Pick<
  IListeningSessionRepository,
  "getProgressForItems" | "getCompletedAtForItems" | "listEverCompletedItems"
>

/** Per-item progress: where the user got to, and whether they finished.
 *  Every scan is bounded to the item's current pass. */
export function createListeningProgressQueries(db: IDatabase): ProgressQueries {
  return {
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
  }
}

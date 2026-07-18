import type { Migration } from "./types.js"

/**
 * Removes duplicate "session-storm" rows: hundreds of overlapping
 * `listening_sessions` created for one item in a single wall-clock second.
 *
 * Cause (fixed in `useListeningSessionTracker`): the player opened sessions
 * fire-and-forget, guarded by a `hasActiveSession()` that only flips true
 * AFTER the awaited insert commits. A burst of native progress events (a
 * seek/scrub, a resume flushing buffered events, or a duplicated progress
 * listener) each passed the guard and opened its OWN row — all reading the
 * same pre-burst high-water mark, so they landed with identical
 * `(item_id, started_at)` and overlapping `[from, to]`. `getTotalListenedSeconds`
 * blind-sums them, so one 57-min track could report ~180h ("7d 18h").
 *
 * What we delete — and why it is SYNC-SAFE:
 *   - Only rows inside an oversized same-instant group (`> 2` rows sharing
 *     `(item_id, started_at)`). Correct operation opens at most one session
 *     per item per second, so `> 2` is unambiguously the storm and never a
 *     legitimate session.
 *   - AND only rows that were never finished (`started_at = ended_at`). Only
 *     `finish`/`finishAt` journal a session to the server, so these phantom
 *     rows were NEVER synced — deleting them locally is invisible to the
 *     server and cannot be resurrected by a later pull. The (rare) finished,
 *     already-synced rows are deliberately LEFT ALONE so we never diverge
 *     from the server's correct copy.
 *
 * This is a local-only raw delete (not journaled): the server total is
 * already correct, so we must not push these deletes upstream.
 */
export const migration_016_listening_sessions_dedupe_storm: Migration = {
  name: "016_listening_sessions_dedupe_storm",
  up: async (db) => {
    await db.execute(
      `DELETE FROM listening_sessions
        WHERE id IN (
          SELECT ls.id
            FROM listening_sessions ls
            JOIN (
              SELECT item_id, started_at
                FROM listening_sessions
               GROUP BY item_id, started_at
              HAVING count(*) > 2
            ) storm
              ON ls.item_id = storm.item_id
             AND ls.started_at = storm.started_at
           WHERE ls.started_at = ls.ended_at
        )`
    )
  },
}

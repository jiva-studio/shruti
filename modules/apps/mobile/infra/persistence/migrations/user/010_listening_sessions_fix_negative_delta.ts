import type { Migration } from "./types.js"

/**
 * Repairs listening sessions whose `to_position < from_position`. These
 * were produced by the old `start()` that set `from_position` to the
 * previous session's `to_position`: replaying a finished lecture (resume
 * resets to 0) or pressing play after seeking back made the new session
 * start before that mark, so `to - from` went negative and silently
 * cancelled the day's heatmap total.
 *
 * The `start()` clamp prevents new bad rows; this flattens the existing
 * ones to a zero-length interval (`from_position = to_position`) so their
 * negative seconds stop dragging down the activity totals.
 */
export const migration_010_listening_sessions_fix_negative_delta: Migration = {
  name: "010_listening_sessions_fix_negative_delta",
  up: async (db) => {
    await db.execute(
      "UPDATE listening_sessions SET from_position = to_position WHERE to_position < from_position"
    )
  },
}

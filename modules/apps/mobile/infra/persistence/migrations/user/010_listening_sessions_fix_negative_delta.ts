import type { Migration } from "./types.js"

/**
 * Flattens listening sessions whose `to_position < from_position` to a
 * zero-length interval (`from_position = to_position`), so negative seconds
 * cannot drag down the heatmap and activity totals. The `start()` clamp keeps
 * new rows from going negative.
 */
export const migration_010_listening_sessions_fix_negative_delta: Migration = {
  name: "010_listening_sessions_fix_negative_delta",
  up: async (db) => {
    await db.execute(
      "UPDATE listening_sessions SET from_position = to_position WHERE to_position < from_position"
    )
  },
}

import { addColumnIfMissing } from "./columns.js"
import type { Migration } from "./types.js"

/**
 * Adds `scheduler_authored` to `chat_messages_proactive_state`, which tells the
 * two kinds of sidecar row apart:
 *
 *   - `scheduler_authored = 1` — the row was born with an autonomously-emitted
 *     message (holiday digest, daily reminder, smart-library hint, …) via
 *     `proactiveState.create()`, which inserts the `chat_messages` row directly,
 *     bypassing the sync-journal decorator. These messages are device-local and
 *     must not sync.
 *   - `scheduler_authored = 0` — an inline-hint cooldown (`proactiveState.attach()`)
 *     stamped onto an ordinary assistant message written through
 *     `chatMessages.create`, and therefore journaled.
 *
 * The other columns cannot make this distinction: `visible_at IS NULL AND
 * notify = 0` is produced both by `attach` and by several autonomous rules.
 *
 * Existing rows default to 0 (eligible to sync): misclassifying an autonomous
 * nudge as syncable only shows a stale nudge on another device, whereas
 * misclassifying a real answer as scheduler-authored loses user content. The
 * UPDATE then marks the rows that are unambiguously scheduler-authored
 * (`notify = 1` or a set `visible_at` — signatures `attach` never produces).
 */
export const migration_015_proactive_state_scheduler_authored: Migration = {
  name: "015_proactive_state_scheduler_authored",
  up: async (db) => {
    await addColumnIfMissing(
      db,
      "chat_messages_proactive_state",
      "scheduler_authored",
      "scheduler_authored INTEGER NOT NULL DEFAULT 0"
    )
    // Re-runnable on its own terms: the predicate matches only rows a replay
    // would already have set, so a second pass writes the same values.
    await db.execute(
      `UPDATE chat_messages_proactive_state
          SET scheduler_authored = 1
        WHERE notify = 1 OR visible_at IS NOT NULL`
    )
  },
}

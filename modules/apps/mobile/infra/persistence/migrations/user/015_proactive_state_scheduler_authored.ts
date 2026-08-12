import { addColumnIfMissing } from "./columns.js"
import type { Migration } from "./types.js"

/**
 * Adds `scheduler_authored` to `chat_messages_proactive_state` so a proactive
 * sidecar row records WHY it exists — and, crucially, lets a reader tell the
 * two very different rows in this table apart:
 *
 *   - `scheduler_authored = 1` — the row was born with an autonomously-emitted
 *     message (holiday digest, daily reminder, smart-library hint, …) via
 *     `proactiveState.create()`, which inserts the `chat_messages` row DIRECTLY
 *     (bypassing `chatMessages.create`, so the sync-journal decorator never
 *     journals it). These messages are device-local and must NOT sync.
 *   - `scheduler_authored = 0` — the row is an **inline-hint cooldown**
 *     (`proactiveState.attach()`) stamped onto an ordinary assistant message
 *     that WAS written through `chatMessages.create` (and hence IS journaled).
 *
 * These two cases previously shared an identical column signature
 * (`visible_at IS NULL AND notify = 0` is produced by both `attach` and several
 * autonomous rules: dailyWisdom / smartLibraryHint / enableNotificationsHint /
 * nextShloka), so "a sidecar row exists" could not distinguish them. The
 * first-sync backfill relied on that (wrong) proxy and dropped inline-hinted
 * real answers, syncing half a conversation. This column makes the distinction
 * explicit instead of guessed.
 *
 * Legacy rows default to 0 (treated as non-scheduler ⇒ eligible to sync): the
 * safe direction, since misclassifying an old autonomous nudge as syncable is
 * harmless (a stale nudge on another device) whereas misclassifying a real
 * answer as scheduler-authored loses user content. The one-time UPDATE then
 * reclaims the rows that are *unambiguously* scheduler-authored (`notify = 1`
 * or a set `visible_at` — signatures `attach` never produces).
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

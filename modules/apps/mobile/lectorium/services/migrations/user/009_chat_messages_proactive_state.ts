import type { Migration } from "./types.js"

/**
 * Scheduling and notification metadata on `chat_messages`, plus a sidecar
 * table holding the proactive scheduler's per-row bookkeeping.
 *
 * - `visible_on` (chat_messages): when non-NULL, the row is hidden from
 *   the chat UI until the user's local date reaches this value. The
 *   render query filters by `visible_on IS NULL OR visible_on <= today`.
 * - `notify_at` / `notified_at` (chat_messages): coords for an optional
 *   `LocalNotification`. `notified_at` is set once the notification has
 *   been scheduled with the OS so the next tick won't re-schedule.
 *
 * `chat_messages_proactive_state` is a 1:1 sidecar for rows that were
 * created by a proactive rule. Regular agent replies and user messages
 * have no row here, so the JOIN in the render query is LEFT.
 *
 * `UNIQUE(rule_kind, rule_date)` makes "one weekly digest per Sunday",
 * "one Janmashtami digest per holiday date" idempotent — the detector
 * INSERTs blindly and relies on the constraint to dedupe.
 */
export const migration_009_chat_messages_proactive_state: Migration = {
  name: "009_chat_messages_proactive_state",
  up: async (db) => {
    await db.execute("ALTER TABLE chat_messages ADD COLUMN visible_on TEXT")
    await db.execute("ALTER TABLE chat_messages ADD COLUMN notify_at INTEGER")
    await db.execute("ALTER TABLE chat_messages ADD COLUMN notified_at INTEGER")

    await db.execute(`
      CREATE TABLE IF NOT EXISTS chat_messages_proactive_state (
        chat_message_id  TEXT    PRIMARY KEY,
        rule_kind        TEXT    NOT NULL,
        rule_date        TEXT    NOT NULL,
        prep_state       TEXT    NOT NULL,
        prepared_at      INTEGER,
        UNIQUE(rule_kind, rule_date),
        FOREIGN KEY (chat_message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
      )
    `)
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_proactive_state_prep_state ON chat_messages_proactive_state(prep_state)"
    )
  },
}

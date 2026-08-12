import type { Migration } from "./types.js"

/**
 * Sidecar holding the proactive scheduler's per-row bookkeeping —
 * a 1:1 companion to `chat_messages` for rows the agent emitted
 * autonomously (holiday digests, daily reminders, smart-library hints,
 * etc). Regular user / assistant chat rows have no entry here, so the
 * render-query joins with LEFT.
 *
 * Final shape, no follow-up ALTER migrations.
 *
 * Columns:
 *   - `rule_kind`      — which proactive rule produced the row
 *                        ('holiday', 'smart_library_hint', 'next_shloka', …).
 *   - `rule_date`      — 'YYYY-MM-DD' idempotency key. `UNIQUE(rule_kind,
 *                        rule_date)` enforces "one Sunday digest", "one
 *                        Janmashtami digest per holiday date". Detector
 *                        INSERTs blindly and relies on the constraint
 *                        for dedup.
 *   - `prep_state`     — 'pending' | 'ready' | 'degraded' | 'dismissed'
 *                        | 'superseded'. Drives render visibility and
 *                        the scheduler's re-prep loop.
 *   - `prepared_at`    — unix-MILLISECONDS (this said seconds, and one writer
 *                        believed it — see migration 028); when content was
 *                        prepped. Used by
 *                        `useProactiveScheduler` to decide if content
 *                        has gone stale and needs re-prep.
 *   - `visible_at`     — unix-seconds; the moment the row becomes visible
 *                        in chat AND (if `notify=1`) the moment an OS
 *                        push fires. ONE unified moment — was previously
 *                        split into `visible_on` (local date) +
 *                        `notify_at` (unix-seconds) on `chat_messages`.
 *   - `notify`         — 0/1 boolean; whether to register an OS
 *                        LocalNotification at `visible_at`. The
 *                        scheduler calls `LocalNotifications.schedule(
 *                        {id: stableHash(chat_message_id), at})`;
 *                        Capacitor's idempotency on `id` removes the
 *                        need for a "did we fire yet" flag.
 *   - `seen_at`        — unix-seconds; first time user opened the session
 *                        containing this row. Drives both the per-session
 *                        dot in history and the tab-level Sadhu badge.
 *                        NULL = unseen; non-NULL = seen.
 *
 * The cascading FK on `chat_message_id` means deleting a chat row also
 * removes its proactive sidecar — keeps the sidecar from leaving orphans.
 */
export const migration_008_chat_messages_proactive_state: Migration = {
  name: "008_chat_messages_proactive_state",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS chat_messages_proactive_state (
        chat_message_id  TEXT    PRIMARY KEY,
        rule_kind        TEXT    NOT NULL,
        rule_date        TEXT    NOT NULL,
        prep_state       TEXT    NOT NULL,
        prepared_at      INTEGER,
        visible_at       INTEGER,
        notify           INTEGER NOT NULL DEFAULT 0,
        seen_at          INTEGER,
        UNIQUE(rule_kind, rule_date),
        FOREIGN KEY (chat_message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
      )
    `)
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_proactive_state_prep_state ON chat_messages_proactive_state(prep_state)"
    )
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_proactive_state_seen_at ON chat_messages_proactive_state(seen_at)"
    )
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_proactive_state_visible_at ON chat_messages_proactive_state(visible_at)"
    )
  },
}

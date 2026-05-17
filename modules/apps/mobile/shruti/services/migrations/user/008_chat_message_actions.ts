import type { Migration } from "./types.js"

/**
 * Action / outline payloads + delivery state for chat messages and sessions.
 *
 * - `actions_json` / `outlines_json` / `action_states_json` — server-side
 *   payloads (`event: action`, `event: outline`) and user's confirm/dismiss
 *   state. Stored as opaque blobs so card widgets re-mount with full data
 *   after reload.
 * - `error` — nullable JSON envelope describing how a message ended
 *   abnormally. Shape is `{ kind: string, ...details }`. Today:
 *     {"kind":"truncated","reason":"stream"}  // SSE dropped
 *     {"kind":"truncated","reason":"turns"}   // MAX_TOOL_TURNS
 *   Tomorrow can grow new `kind` values (rate_limited, blocked, …)
 *   without another ALTER TABLE — the consumer pattern-matches on
 *   `kind` and falls back to a generic "(прервано)" suffix on unknowns.
 * - `title_attempt_count` on `chat_sessions` — number of attempts the
 *   foreground worker has spent calling `/title` for this session. Bounds
 *   retries so a permanently broken `/title` doesn't loop forever.
 */
export const migration_008_chat_message_actions: Migration = {
  name: "008_chat_message_actions",
  up: async (db) => {
    await db.execute("ALTER TABLE chat_messages ADD COLUMN actions_json TEXT NOT NULL DEFAULT '{}'")
    await db.execute(
      "ALTER TABLE chat_messages ADD COLUMN outlines_json TEXT NOT NULL DEFAULT '{}'"
    )
    await db.execute(
      "ALTER TABLE chat_messages ADD COLUMN action_states_json TEXT NOT NULL DEFAULT '{}'"
    )
    await db.execute("ALTER TABLE chat_messages ADD COLUMN error TEXT")
    await db.execute(
      "ALTER TABLE chat_sessions ADD COLUMN title_attempt_count INTEGER NOT NULL DEFAULT 0"
    )
  },
}

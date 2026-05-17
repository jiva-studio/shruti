import type { Migration } from "./types.js"

/**
 * Action / outline payloads + delivery state for chat messages and sessions.
 *
 * - `actions_json` / `outlines_json` / `action_states_json` — server-side
 *   payloads (`event: action`, `event: outline`) and user's confirm/dismiss
 *   state. Stored as opaque blobs so card widgets re-mount with full data
 *   after reload.
 * - `truncated` + `truncate_reason` — marks an assistant message whose
 *   stream ended without `event: done` (`'stream'`: connection dropped;
 *   `'turns'`: agent loop hit MAX_TOOL_TURNS). Set so UI can render an
 *   "interrupted" affordance and downstream turns can skip stale context.
 * - `title_attempt_count` on `chat_sessions` — number of attempts the
 *   foreground worker has spent calling `/title` for this session. Bounds
 *   retries so a permanently broken `/title` doesn't loop forever.
 */
export const migration_008_chat_message_actions: Migration = {
  name: "008_chat_message_actions",
  up: async (db) => {
    await db.execute(
      "ALTER TABLE chat_messages ADD COLUMN actions_json TEXT NOT NULL DEFAULT '{}'"
    )
    await db.execute(
      "ALTER TABLE chat_messages ADD COLUMN outlines_json TEXT NOT NULL DEFAULT '{}'"
    )
    await db.execute(
      "ALTER TABLE chat_messages ADD COLUMN action_states_json TEXT NOT NULL DEFAULT '{}'"
    )
    await db.execute(
      "ALTER TABLE chat_messages ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0"
    )
    await db.execute(
      "ALTER TABLE chat_messages ADD COLUMN truncate_reason TEXT"
    )
    await db.execute(
      "ALTER TABLE chat_sessions ADD COLUMN title_attempt_count INTEGER NOT NULL DEFAULT 0"
    )
  },
}

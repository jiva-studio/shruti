import type { Migration } from "./types.js"

/**
 * Action / outline payloads attached to assistant chat messages.
 *
 * Server emits SSE `event: action` and `event: outline` alongside text
 * deltas; their payloads can't be reconstructed from the message
 * content alone (only the inline `[action:.|id=...]` / `[outline:...]`
 * marker survives there). We store them as JSON blobs so card widgets
 * re-mount with full data after a reload, and so the user's confirm /
 * dismiss state on each action persists across app restarts.
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
  },
}

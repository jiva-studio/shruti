import type { Migration } from "./types.js"

/**
 * `followups_json` — JSON array of follow-up chip texts the LLM emitted
 * via `[followup:<text>]` markers at the end of the message content.
 *
 * Stored as a flat JSON array (not the versioned `{ _v, data }`
 * envelope used by `actions_json` / `outlines_json` / `action_states_json`)
 * because the payload is just `string[]` — no shape evolution to worry
 * about. The bubble renders chips only under the latest assistant
 * message of a session; persisting them survives app reloads so a
 * cold-start session resumes with its chips intact.
 */
export const migration_011_chat_message_followups: Migration = {
  name: "011_chat_message_followups",
  up: async (db) => {
    await db.execute(
      "ALTER TABLE chat_messages ADD COLUMN followups_json TEXT NOT NULL DEFAULT '[]'"
    )
  },
}

import type { Migration } from "./types.js"

/**
 * Repairs the two ways `chat_messages_proactive_state` lied about its rows.
 *
 * 1. `prepared_at` is unix-**milliseconds** — that is what `updatePrepState`
 *    writes and what the scheduler's staleness check compares against.
 *    `attach()` wrote unix-seconds, so every inline-hint cooldown marker read
 *    back as ~1970 and counted as permanently stale, which drove the scheduler
 *    to re-run `buildContent` and overwrite the host answer's body. Values of
 *    seconds magnitude (< 1e11 ⇒ before 1973 read as ms) are scaled up; a real
 *    ms stamp has been > 1e12 since 2001, so a replay is a no-op.
 *
 * 2. `scheduler_authored` was added by 015 with `DEFAULT 0`, which silently
 *    relabelled every pre-015 autonomous row as an inline-hint cooldown marker
 *    unless it carried `notify = 1` or a `visible_at`. Readers that must tell
 *    the two tenants apart (the thread's visibility gate, the scheduler's prep
 *    loop, the terminal-state sweep) would then treat an old proactive body as
 *    a marker on a real answer. Reclaim them with the two signatures `attach()`
 *    can never produce: a `rule_kind` with no inline-hint counterpart, or a
 *    session with no user turn in it (autonomous hints open their own session;
 *    a marker always sits on an answer to a question).
 */
export const migration_028_proactive_state_units_and_authorship: Migration = {
  name: "028_proactive_state_units_and_authorship",
  up: async (db) => {
    await db.execute(
      `UPDATE chat_messages_proactive_state
          SET prepared_at = prepared_at * 1000
        WHERE prepared_at IS NOT NULL
          AND prepared_at > 0
          AND prepared_at < 100000000000`
    )
    await db.execute(
      `UPDATE chat_messages_proactive_state
          SET scheduler_authored = 1
        WHERE scheduler_authored = 0
          AND (rule_kind NOT IN ('enable_notifications_hint', 'smart_library_hint')
               OR NOT EXISTS (
                 SELECT 1
                   FROM chat_messages host
                   JOIN chat_messages peer ON peer.session_id = host.session_id
                  WHERE host.id = chat_messages_proactive_state.chat_message_id
                    AND peer.role = 'user'))`
    )
  },
}

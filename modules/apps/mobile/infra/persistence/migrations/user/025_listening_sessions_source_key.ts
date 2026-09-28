import { addColumnIfMissing } from "./columns.js"
import type { Migration } from "./types.js"

/**
 * Durable dedup key for sessions folded in from the native queue journal.
 *
 * The native transition journal is durable and only `ackEvents` removes an
 * entry, so a batch whose ack never landed is replayed on the next launch.
 * Every insert stamps a fresh `nowSec()`, so without a key a replay lands in
 * its own `(item_id, started_at)` group and the listening totals count the
 * same minutes twice.
 *
 * `source_key` gives such a row the identity of the transition it came from
 * (`queue:<seq>:<item>:<at>` — all three values are assigned once, natively,
 * and re-presented verbatim on every replay). The UNIQUE index enforces it. It
 * is deliberately NOT partial: SQLite treats NULLs as distinct in a unique
 * index, so sessions from the ordinary player path keep a NULL and are
 * unaffected.
 *
 * Local-only: `sessionRowToWire` enumerates its fields, so the key never
 * reaches the wire — a device re-deriving a session from the server has its own
 * native journal and its own keys.
 */
export const migration_025_listening_sessions_source_key: Migration = {
  name: "025_listening_sessions_source_key",
  up: async (db) => {
    await addColumnIfMissing(db, "listening_sessions", "source_key", "source_key TEXT")
    await db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_listening_sessions_source_key
         ON listening_sessions(source_key)`
    )
  },
}

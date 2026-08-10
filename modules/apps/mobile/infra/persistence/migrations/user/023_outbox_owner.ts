import { addColumnIfMissing } from "./columns.js"
import type { Migration } from "./types.js"

/**
 * Stamp each outbox row with the account that journaled it (#1497).
 *
 * The journal is keyed by device, not by account, and a local wipe / account
 * deletion leaves it intact — so un-pushed rows written by a deleted account
 * were uploaded under the next anonymous identity. `pushed_outbox_id` alone
 * cannot separate them: it is an id watermark, and the engine only learns the
 * identity changed on its next cycle, by which point the NEW account may
 * already have journaled rows that raising the watermark would retire.
 *
 * `owner_id` makes ownership a property of the row instead of a moment in
 * time. Existing rows migrate to NULL — unattributable, so they stay governed
 * by the watermark, which the engine jumps to the journal's tail on an
 * identity change (retiring exactly the rows that predate it).
 *
 * No index: the pending scan is `sent = 0 AND (owner_id = ? OR (owner_id IS
 * NULL AND id > ?))`, and the `OR` defeats a composite on `owner_id`. Measured
 * on SQLite 3.51.2 over a 200k-row outbox, with and without `ANALYZE`, the
 * planner picks the existing `idx_outbox_pending (sent, id)` either way — it
 * also satisfies `ORDER BY id` for the `LIMIT`. A `(sent, owner_id, id)` index
 * is chosen only for a query this code never issues, so it would buy one more
 * b-tree write per journaled row and no reads.
 */
export const migration_023_outbox_owner: Migration = {
  name: "023_outbox_owner",
  up: async (db) => {
    await addColumnIfMissing(db, "outbox", "owner_id", "owner_id TEXT")
  },
}

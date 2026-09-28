import type { Migration } from "./types.js"

/**
 * One-time compaction of superseded `outbox` rows already on disk.
 *
 * The push path compacts incrementally (`IOutboxRepository.prune`), but only
 * for the documents in the batch it just acknowledged, so a document nobody
 * writes to again is never revisited. This pass clears those rows once.
 *
 * Same predicate as the incremental prune, minus the per-document filter:
 *
 *   - `sent = 1` — a pending row is still owed to the server;
 *   - strictly below the watermark — `MIN(pushed_outbox_id)` over `sync_state`
 *     is the conservative reading of a device-keyed table, and a device that
 *     has never pushed has no row at all, which `COALESCE` turns into "prune
 *     nothing" rather than "prune everything";
 *   - superseded — a NEWER row exists for the same `(collection, doc_id)`.
 *
 * Every document keeps its newest row, so `wasJournaled`, the first-sync
 * backfill's anti-join and the anonymous→account handover's replay all still
 * see it; the journal's tail survives too, so `latestHlc` still seeds the HLC
 * chain and `latestId` still names the id an identity change retires the
 * journal at.
 *
 * Idempotent: the predicate is false for every row left behind. There is no
 * `VACUUM` (it would rewrite a large user database at startup); SQLite reuses
 * the freed pages for later rows.
 */
export const migration_029_outbox_compaction: Migration = {
  name: "029_outbox_compaction",
  up: async (db) => {
    await db.execute(
      `DELETE FROM outbox
        WHERE sent = 1
          AND id < COALESCE((SELECT MIN(pushed_outbox_id) FROM sync_state), 0)
          AND EXISTS (SELECT 1 FROM outbox newer
                       WHERE newer.collection = outbox.collection
                         AND newer.doc_id = outbox.doc_id
                         AND newer.id > outbox.id)`
    )
  },
}

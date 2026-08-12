import type { Migration } from "./types.js"

/**
 * One-time compaction of the journal every install is already carrying (#1798).
 *
 * The `outbox` was append-only for the life of the install: `markSent` flipped
 * a flag and the only `DELETE` was the data wipe, so every closed listening
 * session, playlist change, note and chat message left a full JSON snapshot
 * behind forever — and a chat answer left three (the `create`, then the
 * in-place `meta` rewrites behind `updateActionStates` / `updateFollowups`),
 * each carrying the whole message text again.
 *
 * The push path now compacts as it goes (`IOutboxRepository.prune`), but only
 * for the documents in the batch it just acknowledged: that is what keeps the
 * steady-state cost an index seek per row instead of a scan of the very table
 * whose size is the problem. A document nobody writes to again is therefore
 * never revisited, so the superseded rows already on disk would stay there for
 * good. This is the pass that clears them, once.
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
 * That last clause is what makes this safe to run behind the user's back.
 * Every document keeps its newest row, so `wasJournaled`, the first-sync
 * backfill's anti-join, and the anonymous→account handover's replay (#1627)
 * all still see it; the journal's tail is kept for the same reason (nothing
 * supersedes it), which is what leaves `latestHlc` seeding the HLC chain and
 * `latestId` naming the id an identity change retires the journal at.
 *
 * Idempotent: the predicate is already false for every row left behind, so the
 * replay of an interrupted migration deletes nothing more. The freed pages are
 * not handed back to the filesystem — there is no `VACUUM` here, which on a
 * large user database would rewrite the whole file at startup — but SQLite
 * reuses them for the rows that follow, so the file stops growing.
 */
export const migration_028_outbox_compaction: Migration = {
  name: "028_outbox_compaction",
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

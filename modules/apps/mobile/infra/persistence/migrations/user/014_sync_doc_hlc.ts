import type { Migration } from "./types.js"

/**
 * Per-document last-seen server HLC, maintained by the sync engine.
 *
 * The sync protocol is optimistically concurrent: a pushed change carries a
 * `base_hlc` — "the last server HLC this device saw for this doc" — and the
 * server applies the write only when `base_hlc` still matches the current
 * master (else it returns a conflict for the client to re-merge). The journal
 * decorator leaves `outbox.base_hlc` NULL because the write-path has no view
 * of server state; reconciling it is the engine's job.
 *
 * This table is that reconciliation source: one row per `(collection, doc_id)`
 * recording the HLC the server last confirmed / delivered for that document.
 * It is maintained entirely by the engine, never the write-path:
 *
 * - **pull** — after applying a remote change, `server_hlc` is set to that
 *   change's HLC (the doc's new master, which becomes our next push base).
 * - **push applied** — the pushed change's HLC becomes the doc's master.
 * - **push conflict** — the returned `master.hlc` becomes the base for the
 *   re-merged, re-journaled change.
 *
 * A side-table keeps the synced collection schemas untouched, survives a row
 * being tombstoned (a delete still needs a base for the next write), and is
 * cleared wholesale by the data-reset path (`wipeLocalUserData`) alongside
 * `outbox`. `sync_state` is not cleared there — rewinding its `pull_cursor`
 * would re-pull everything the wipe deleted; see that function's header.
 */
export const migration_014_sync_doc_hlc: Migration = {
  name: "014_sync_doc_hlc",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS sync_doc_hlc (
        collection TEXT NOT NULL,
        doc_id     TEXT NOT NULL,
        server_hlc TEXT NOT NULL,
        PRIMARY KEY (collection, doc_id)
      )
    `)
  },
}

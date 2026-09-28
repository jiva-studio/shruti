import type { Migration } from "./types.js"

/**
 * Lookup index for "has this document ever entered sync?".
 *
 * The sync-journal decorator asks that before every tombstone and re-journal
 * (`wasJournaled`, and the `IN` subquery behind `chatMessages.deleteBySession`),
 * always as `collection = ? AND doc_id = ?` and inside the delete's write
 * transaction. The pending-scan indexes are led by `sent` and cannot serve that
 * predicate, so without this index the probe is a full outbox scan.
 * `sync_doc_hlc` needs no companion: its primary key is already this index.
 *
 * Idempotent (`IF NOT EXISTS`), so a replay after an interrupted migration is a
 * no-op.
 */
export const migration_024_outbox_collection_docid_index: Migration = {
  name: "024_outbox_collection_docid_index",
  up: async (db) => {
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_outbox_collection_doc ON outbox(collection, doc_id)"
    )
  },
}

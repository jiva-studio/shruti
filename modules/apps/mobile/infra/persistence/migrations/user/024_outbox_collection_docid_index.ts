import type { Migration } from "./types.js"

/**
 * Lookup index for "has this document ever entered sync?" (#1498).
 *
 * The sync-journal decorator asks that question before every tombstone and
 * every re-journal (`wasJournaled`, and the `IN` subquery behind
 * `chatMessages.deleteBySession`), always as `collection = ? AND doc_id = ?`.
 * The existing outbox indexes are both pending-scan indexes led by `sent`
 * (`idx_outbox_pending (sent, id)`, `idx_outbox_pending_owner
 * (sent, owner_id, id)`), so neither can serve that predicate — the probe
 * degraded to a full scan of a table that is append-only and never compacted,
 * i.e. one that grows monotonically for the life of the install. On a device
 * with a large journal that scan ran inside the delete's write transaction,
 * which is a visible hang on "delete chat".
 *
 * `(collection, doc_id)` is the equality prefix those probes need. It does not
 * overlap the pending-scan indexes: their leading `sent` column cannot answer
 * a collection-keyed lookup, and this one cannot answer an ordered pending
 * scan — the two access paths are disjoint, so both are warranted.
 *
 * `sync_doc_hlc` needs no companion: its `PRIMARY KEY (collection, doc_id)`
 * already materialises exactly this index.
 *
 * Additive and idempotent (`IF NOT EXISTS`) — the index-level equivalent of
 * the `addColumnIfMissing` guard, so a replay after an interrupted migration
 * is a harmless no-op.
 */
export const migration_024_outbox_collection_docid_index: Migration = {
  name: "024_outbox_collection_docid_index",
  up: async (db) => {
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_outbox_collection_doc ON outbox(collection, doc_id)"
    )
  },
}

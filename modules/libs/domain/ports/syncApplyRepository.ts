import type { SyncDoc } from "../sync/types.js"

/**
 * Port for applying **remote** sync changes to the local collection tables and
 * for the per-document server-HLC bookkeeping that drives optimistic
 * concurrency.
 *
 * It is deliberately separate from the domain repositories (`INoteRepository`,
 * …): those are wrapped by the sync-journal decorator, so writing a pulled
 * change through them would re-journal it into the outbox and echo it straight
 * back to the server. This port writes the raw collection rows **without
 * journaling**, and maintains the `sync_doc_hlc` side-table (014 migration)
 * that records the last server-known HLC per doc — the `base_hlc` source for
 * push and the local doc's known HLC on pull-merge.
 *
 * Domain port — the SQL implementation lives in `@infra/repositories/sql`.
 * Every method joins the caller's reentrant unit-of-work; none opens its own
 * transaction (SQLite has no nested transactions).
 *
 * `data` on the {@link SyncDoc}s handled here is the client-native
 * (snake_case) `user.db` row snapshot — exactly what the outbox / wire carry —
 * so the adapter can map it straight onto columns.
 */
export interface ISyncApplyRepository {
  /**
   * Read the current local document for a merge, or `null` when neither the
   * row nor any bookkeeping for it exists. The returned `hlc` is the doc's
   * known local HLC: the greater of any pending outbox change's HLC and the
   * last recorded server HLC. `data` is the row's wire-shaped snapshot;
   * `deleted` is `true` when the doc is locally absent but a server HLC is
   * still on record (a tombstone the device has already seen).
   */
  getLocalDoc(collection: string, docId: string): Promise<SyncDoc<unknown> | null>

  /**
   * Persist a resolved document to its collection table (upsert when
   * `doc.deleted` is false, delete/tombstone when true) **without journaling**,
   * and record `serverHlc` as this doc's new last-server-known HLC. `serverHlc`
   * is passed separately from `doc.hlc` because on a merge the winning local
   * doc's HLC can differ from the server master pointer we must remember.
   */
  applyRemote(collection: string, doc: SyncDoc<unknown>, serverHlc: string): Promise<void>

  /** Last server-known HLC for a doc (the `base_hlc` source), or `null`. */
  lastServerHlc(collection: string, docId: string): Promise<string | null>

  /** Record `hlc` as the doc's last server-known HLC (push apply / conflict). */
  recordServerHlc(collection: string, docId: string, hlc: string): Promise<void>
}

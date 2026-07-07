/**
 * A pre-journaling local row surfaced for the first-sync backfill (Lane E2b):
 * its collection, natural sync key, and the client-native (snake_case) wire
 * snapshot — byte-identical to what the sync-journal decorator writes into
 * `outbox.data`. Emitted only for rows that have **no** `outbox` entry AND
 * **no** `sync_doc_hlc` record, i.e. rows created while the device was
 * anonymous / before journaling was on.
 */
export interface BackfillCandidate {
  /** Sync collection = source `user.db` table name. */
  readonly collection: string
  /** Natural sync key (`track_id` for `playlist_items`, the row id otherwise). */
  readonly docId: string
  /** Client-native wire row snapshot. Never `null`: the backfill only enqueues
   *  `upsert`s of live rows — it never fabricates a delete tombstone. */
  readonly data: unknown
}

/**
 * Read-only port that enumerates local rows in the synced collections
 * (`notes`, `playlist_items`, `listening_sessions`, and — when chat sync is on
 * — the user-initiated `chat_sessions` / `chat_messages`) which predate
 * journaling: they have neither an `outbox` row nor a `sync_doc_hlc` record, so
 * the first-sync backfill (`@usecases/sync/backfillLocal`) can enqueue them for
 * upload the first time a real account signs in on this device. Chat rows are
 * gated + filtered to mirror the journal decorator (toggle-respecting,
 * proactive-excluding, parent-before-child) so a re-signed device uploads the
 * same chat history it would have journaled live.
 *
 * The anti-join against `outbox` / `sync_doc_hlc` **is** the idempotency guard:
 * once a candidate has been enqueued it owns an outbox row and is no longer
 * returned, so a second backfill pass finds nothing and cannot double-enqueue.
 *
 * Domain port — the SQL implementation lives in `@infra/repositories/sql`.
 * Reads only; it joins the caller's reentrant unit-of-work like the other sync
 * ports and never opens its own transaction.
 */
export interface ISyncBackfillRepository {
  /** All un-journaled rows across the synced collections, as wire snapshots. */
  listUnsynced(): Promise<readonly BackfillCandidate[]>
}

import type { SyncOp } from "../sync/types.js"

/**
 * A pending local change read out of the `outbox` for push, in the clean
 * (already-deserialized) shape the sync engine reasons about. `data` is the
 * client-native `user.db` row snapshot (opaque to the engine except when it
 * maps it to a merge payload); `null` on a delete tombstone.
 */
export interface OutboxEntry {
  /** Autoincrement rowid — the local push cursor / insertion order. */
  readonly id: number
  /** Sync collection = source `user.db` table name. */
  readonly collection: string
  /** Natural sync key (e.g. `track_id` for `playlist_items`). */
  readonly docId: string
  readonly op: SyncOp
  /** Deserialized wire row snapshot; `null` on a delete. */
  readonly data: unknown | null
  /** HLC stamped on this change. */
  readonly hlc: string
  /** Last-seen server HLC the change derived from; `null` until the engine
   *  reconciles it (see {@link ISyncApplyRepository.lastServerHlc}). */
  readonly baseHlc: string | null
}

/**
 * A new outbox row the engine appends when it re-journals the result of a
 * conflict re-merge (the merged doc, stamped with a fresh HLC and the
 * server's `master.hlc` as its base).
 */
export interface NewOutboxEntry {
  readonly collection: string
  readonly docId: string
  readonly op: SyncOp
  /** Wire row snapshot to persist; `null` on a delete tombstone. */
  readonly data: unknown | null
  readonly hlc: string
  readonly baseHlc: string | null
}

/**
 * Read/write port over the local `outbox` journal (013 migration), consumed
 * by the sync engine's push path. Reads pending (unsent) changes, marks them
 * acknowledged once the server applies them, and appends re-merged changes.
 *
 * Domain port — the SQL implementation lives in `@infra/repositories/sql`.
 * All mutations join the caller's reentrant unit-of-work; the port body never
 * opens its own transaction.
 */
export interface IOutboxRepository {
  /**
   * Pending (`sent = 0`) changes in insertion (`id`) order, oldest first.
   * `limit` bounds the batch so a push stays within the edge's body cap.
   */
  listPending(limit?: number): Promise<readonly OutboxEntry[]>

  /** Mark the given outbox rows acknowledged (`sent = 1`). Idempotent. */
  markSent(ids: readonly number[]): Promise<void>

  /** Append a new pending change (used to re-journal a conflict re-merge). */
  append(entry: NewOutboxEntry): Promise<void>

  /**
   * The highest HLC ever journaled, or `null` when the outbox is empty.
   * Seeds the next monotonic HLC when the engine stamps a re-merged change.
   */
  latestHlc(): Promise<string | null>
}

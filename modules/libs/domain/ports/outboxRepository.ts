import type { SyncDocRef, SyncOp } from "../sync/types.js"

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
  /**
   * Last-seen server HLC the change derived from; `null` until the engine
   * reconciles it (see `ISyncApplyRepository.lastServerHlc`). An explicit `""`
   * is stronger than "unknown": it asserts the change descends from nothing the
   * pushing ACCOUNT has, so push sends an empty base rather than the doc's
   * recorded master.
   */
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
  /**
   * The account to attribute the row to. Set it whenever the row belongs to a
   * specific identity rather than to "now" — a conflict re-merge is the
   * previous push's document and must stay with the account that wrote it,
   * even if the device changed hands during the round-trip. Omitted ⇒ the
   * adapter stamps whoever owns the device at insert time.
   */
  readonly ownerId?: string | null
}

/**
 * Which pending rows a push may read. Both arms answer the same question —
 * "was this row journaled by the account pushing now?" — from opposite ends:
 * `ownerId` matches rows stamped with the account (023 migration), `afterId`
 * covers the unstamped ones, which are the current owner's only while the
 * watermark still sits where their pushes left it.
 */
export interface OutboxScope {
  /** The account draining the outbox. Rows stamped with a different owner are
   *  never returned — that is what keeps a deleted account's changes off the
   *  identity that replaces it, whenever the engine notices the switch. */
  readonly ownerId?: string | null
  /** The watermark (`sync_state.pushed_outbox_id`, 0 when omitted). Unstamped
   *  rows at or below it are retired: either pushed, or predating an identity
   *  change, which jumps the watermark to the journal's tail. */
  readonly afterId?: number
}

/**
 * Which rows a re-attribution moves from a superseded anonymous identity to
 * the account that replaced it (#1627). The two arms mirror {@link OutboxScope}
 * — they select exactly the rows the outgoing identity was allowed to push —
 * so the handover carries its journal and nothing else.
 */
export interface OutboxReattribution {
  /** The anonymous account being left behind. */
  readonly fromOwnerId: string
  /** The account signing in. */
  readonly toOwnerId: string
  /**
   * Unowned rows at or below this id were retired by an EARLIER identity
   * change and belong to whoever came before the anonymous one; they stay
   * behind. `0` on a device that has never retired a journal, where every
   * unstamped row is the anonymous owner's.
   */
  readonly unownedAfterId: number
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
   * Pending (`sent = 0`) changes in insertion (`id`) order, oldest first,
   * narrowed to the rows {@link OutboxScope} says the caller owns. `limit`
   * bounds the batch so a push stays within the edge's body cap.
   */
  listPending(limit?: number, scope?: OutboxScope): Promise<readonly OutboxEntry[]>

  /** Mark the given outbox rows acknowledged (`sent = 1`). Idempotent. */
  markSent(ids: readonly number[]): Promise<void>

  /** Append a new pending change (used to re-journal a conflict re-merge). */
  append(entry: NewOutboxEntry): Promise<void>

  /**
   * Move an anonymous identity's journal to the account that signed in on top
   * of it, and un-send it so the push replays it under the new owner (#1627).
   * Returns the distinct documents it touched — their `sync_doc_hlc` pointers
   * name the anonymous account's masters and have to be forgotten, or the
   * replay would push against a base the new account never had.
   *
   * Each row keeps its original HLC: the replay competes with the target
   * account's own versions on the real write order, so re-stamping it "now"
   * (what a re-run of the first-sync backfill would do) is exactly what would
   * let a stale local copy silently beat a newer one from another device.
   *
   * Idempotent — a second call finds no rows left in scope, which is what
   * makes an interrupted handover safe to resume.
   */
  reattribute(scope: OutboxReattribution): Promise<readonly SyncDocRef[]>

  /**
   * The highest HLC ever journaled, or `null` when the outbox is empty.
   * Seeds the next monotonic HLC when the engine stamps a re-merged change.
   */
  latestHlc(): Promise<string | null>

  /**
   * The highest `id` ever journaled (sent or not), `0` when the outbox is
   * empty. Stamped as the watermark when the owning identity changes, which
   * retires the unstamped rows journaled so far. Owned rows are unaffected —
   * the engine may notice the switch long after the new account started
   * writing, and those writes must survive it.
   */
  latestId(): Promise<number>

  /**
   * Drop every journaled row — the local data-wipe path (#1496). The rows
   * describe local documents that no longer exist, and nothing else retires
   * them: `owner_id` only separates identities, so on a wipe that keeps the
   * same account they would still be pushed, re-creating the wiped data on the
   * server and on every other device.
   *
   * Safe against the `pushed_outbox_id` watermark, which is NOT rewound: `id`
   * is `INTEGER PRIMARY KEY AUTOINCREMENT`, so a delete leaves `sqlite_sequence`
   * alone and the next journaled row still lands above the watermark.
   */
  clearAll(): Promise<void>
}

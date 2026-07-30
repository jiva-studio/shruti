/**
 * Domain-side sync primitives shared by the per-collection merge rules.
 *
 * These are the *clean* (camelCase) shapes the merge logic reasons about — the
 * snake_case transport (`*Wire`) types live in `@lib/contracts` (Lane C) and
 * are mapped at the infra boundary. Kept dependency-free so the merge rules
 * stay pure and unit-testable.
 */

/** The sync collections whose merge rules live in the domain. Mirrors the
 *  `user.db` table names (the collection name equals the table name).
 *  `chat_sessions` / `chat_messages` are the user-initiated chat collections
 *  (Lane G); both merge last-write-wins by HLC. */
export type SyncCollection =
  | "playlist_items"
  | "listening_sessions"
  | "notes"
  | "chat_sessions"
  | "chat_messages"
  | "library_items"

/** A change operation as journaled in the outbox / replicated over the wire. */
export type SyncOp = "upsert" | "delete"

/**
 * One collection document as seen by the merge layer: its natural key, the HLC
 * stamped on the write, and the payload (or `null` when the document is a
 * tombstone). `T` is the collection-specific payload shape.
 */
export interface SyncDoc<T> {
  /** Natural sync key. For `playlist_items` this is the `track_id`, NOT the
   *  local surrogate `pl_…` id; for `notes` / `listening_sessions` it is the
   *  row's own id. */
  readonly docId: string
  /** HLC stamped on this version — the conflict tiebreak. */
  readonly hlc: string
  /** `true` when this version is a delete tombstone (`op = 'delete'`). */
  readonly deleted: boolean
  /** Payload; `null` iff {@link deleted}. */
  readonly data: T | null
}

/** Payload shape the `playlist_items` add-wins rule reasons over. Add/archive
 *  are timestamps (unix ms); `archivedAt === null` means the item is active. */
export interface PlaylistItemSyncData {
  readonly trackId: string
  readonly addedAt: number
  readonly archivedAt: number | null
  readonly collectionId: string | null
}

/**
 * Payload the `library_items` rule reasons over. This collection is
 * **server-owned and pull-only** — the client never writes it, so there is no
 * field-level merge: the rule simply applies the server's version wholesale.
 * The shape carries the projected `profile.library_items` columns (snake_case
 * mapping happens at the infra boundary in `syncWire` / `mergeRouting`).
 */
export interface LibraryItemSyncData {
  readonly id: string
  readonly trackId: string | null
  readonly status: string
  readonly origin: string | null
  readonly titleRaw: string | null
  readonly authorRaw: string | null
  readonly locationRaw: string | null
  readonly dateRaw: string | null
  readonly langHint: string | null
  readonly authorId: string | null
  readonly locationId: string | null
  readonly date: string | null
  readonly lang: string | null
  readonly error: string | null
  readonly audioKey: string | null
  readonly transcriptKey: string | null
  readonly duration: number | null
  readonly coverKey: string | null
  readonly createdAt: number | null
  readonly updatedAt: number | null
}

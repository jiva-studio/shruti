/**
 * Profile-sync **wire protocol** — the transport contract between the
 * mobile / web clients and the `profile` Go service
 * (`POST /profile/sync/{pull,push,cursor}`).
 *
 * These types are hand-authored and mirror the Go structs in the service
 * handler **exactly**, field-for-field, in the JSON shape the server emits
 * (snake_case). They live in `@lib/contracts` (the dependency-free shared
 * kernel) for the same reason the chat SSE contracts do: the transport
 * port below is both consumed by an application use case (the sync engine,
 * `@usecases`) and implemented by an infrastructure adapter
 * (`@infra/sync/http/*`), and the layer rules leave no other shared home
 * (`@ports/app` may not import `@lib/*`; `@usecases` may not import
 * `@infra`).
 *
 * Scope: **pure transport**. No HLC math, no merge, no orchestration —
 * `data` is an opaque JSON blob to this layer, and `hlc` / `base_hlc` are
 * opaque strings. The domain (`@lib/domain/sync`, Lane B) owns the HLC
 * value object and the per-collection merge rules; the sync engine
 * (`@usecases`, Lane D) maps these wire DTOs to/from the domain shapes.
 *
 * Go ↔ TS field-name map (authoritative — do not drift):
 *   server_seq · collection · doc_id · op · data · hlc · base_hlc
 *   device_id · cursor · limit · has_more · changes · applied · conflicts
 *   master · acked_seq
 */

/**
 * Hybrid Logical Clock, as it appears on the wire: an opaque string of the
 * form `<physical_ms>:<counter>:<device_id>`. Kept as a bare `string` here
 * on purpose — the transport never parses or compares it; the domain HLC
 * value object (Lane B) is a separate, richer type. Aliased only for
 * self-documentation of the fields that carry one.
 */
export type Hlc = string

/** Change operation. `delete` replicates as a tombstone (never a hard
 *  delete on the server), so `data` is null/absent on a delete row. */
export type SyncOp = "upsert" | "delete"

/**
 * One change row. On **pull** the server stamps `server_seq` (the
 * monotonic `global_seq` cursor value); on the request side it is absent.
 * `data` carries the client-native `user.db` row verbatim (opaque JSON) on
 * an `upsert`, and is null/omitted on a `delete`.
 *
 * Mirrors Go:
 * ```go
 * type Change struct {
 *   ServerSeq  int64           `json:"server_seq,omitempty"` // pull only
 *   Collection string          `json:"collection"`
 *   DocID      string          `json:"doc_id"`
 *   Op         string          `json:"op"`
 *   Data       json.RawMessage `json:"data,omitempty"`
 *   HLC        string          `json:"hlc"`
 * }
 * ```
 */
export interface Change {
  /** Server-assigned `global_seq`. Present only on pull responses
   *  (`omitempty` on the request side). */
  readonly server_seq?: number
  readonly collection: string
  readonly doc_id: string
  readonly op: SyncOp
  /** The `user.db` row, opaque to the transport. Absent / null on a
   *  `delete` tombstone. */
  readonly data?: unknown
  readonly hlc: Hlc
}

/**
 * `POST /profile/sync/pull` request. The client always pulls **all**
 * collections under one monotonic cursor, so a single `cursor` is
 * sufficient and total ordering holds. `limit` is clamped server-side to a
 * hard maximum.
 *
 * Mirrors Go: `type PullRequest struct { Cursor int64; Limit int }`.
 */
export interface PullRequest {
  readonly cursor: number
  readonly limit: number
}

/**
 * `POST /profile/sync/pull` response. `changes` are ordered by
 * `global_seq`, exclude the caller's own device (echo suppression), and
 * are paginated via `has_more`. `cursor` is the highest `global_seq` in
 * this page — the client advances its local cursor to it.
 *
 * Mirrors Go:
 * `type PullResponse struct { Changes []Change; Cursor int64; HasMore bool }`.
 */
export interface PullResponse {
  readonly changes: readonly Change[]
  readonly cursor: number
  readonly has_more: boolean
}

/**
 * One change the client wants to push. `base_hlc` is the last server HLC
 * the client saw for this doc (`""` / absent ⇒ the client believes the doc
 * is new); the server applies the row iff `base_hlc` matches the current
 * master, else returns it under `conflicts`.
 *
 * Mirrors Go:
 * ```go
 * type PushItem struct {
 *   Collection string          `json:"collection"`
 *   DocID      string          `json:"doc_id"`
 *   Op         string          `json:"op"`
 *   Data       json.RawMessage `json:"data,omitempty"`
 *   HLC        string          `json:"hlc"`
 *   BaseHLC    string          `json:"base_hlc,omitempty"`
 * }
 * ```
 */
export interface PushItem {
  readonly collection: string
  readonly doc_id: string
  readonly op: SyncOp
  /** The `user.db` row, opaque to the transport. Absent / null on a
   *  `delete` tombstone. */
  readonly data?: unknown
  readonly hlc: Hlc
  /** Last-seen server HLC for this doc. `""` / absent ⇒ new doc. */
  readonly base_hlc?: Hlc
}

/**
 * `POST /profile/sync/push` request. `device_id` is the writer, used by
 * the server for echo suppression on subsequent pulls. `user_id` is taken
 * **only** from the JWT — it is never carried in the body.
 *
 * Mirrors Go: `type PushRequest struct { DeviceID string; Changes []PushItem }`.
 */
export interface PushRequest {
  readonly device_id: string
  readonly changes: readonly PushItem[]
}

/**
 * A `(collection, doc_id)` reference. Returned in `applied` to acknowledge
 * a successfully-written change.
 *
 * Mirrors Go: `type Ref struct { Collection string; DocID string }`.
 */
export interface Ref {
  readonly collection: string
  readonly doc_id: string
}

/**
 * A rejected (stale-base) change, returned with the current server
 * `master` row so the client can re-merge by the collection's rule and
 * re-push with `base_hlc = master.hlc`.
 *
 * Mirrors Go:
 * `type Conflict struct { Collection string; DocID string; Master Change }`.
 */
export interface Conflict {
  readonly collection: string
  readonly doc_id: string
  readonly master: Change
}

/**
 * `POST /profile/sync/push` response. **No cursor** — the pull cursor
 * advances only via pull. `applied` lists the writes that landed;
 * `conflicts` lists the stale ones for the client to re-merge.
 *
 * Mirrors Go:
 * `type PushResponse struct { Applied []Ref; Conflicts []Conflict }`.
 */
export interface PushResponse {
  readonly applied: readonly Ref[]
  readonly conflicts: readonly Conflict[]
}

/**
 * `POST /profile/sync/cursor` request. Acknowledges the highest
 * `global_seq` this device has applied, which drives server-side log
 * compaction and resume.
 *
 * Mirrors Go: `type CursorRequest struct { DeviceID string; AckedSeq int64 }`.
 */
export interface CursorRequest {
  readonly device_id: string
  readonly acked_seq: number
}

/**
 * Transport boundary for the `profile` sync service. Pure wire-level
 * request/response — serialize → call → deserialize. No merge, no HLC, no
 * cursor bookkeeping (the sync engine in `@usecases` owns all of that).
 *
 * The mobile HTTP adapter (`@infra/sync/http/syncClient.ts`) implements it
 * over `fetch` + JWT; a fake implementation drives the engine's tests
 * without a live server. It parallels `IChatStreamClient`: a port in the
 * shared kernel so the use case imports a contract, not a concrete
 * service.
 *
 * The port does **not** itself gate on the token being anonymous — mirror
 * `IChatStreamClient`, whose adapter streams for any non-null token and
 * leaves the "should we run at all" decision to the caller. The sync
 * engine only invokes this once the account is signed-in.
 */
export interface ISyncClient {
  /** `POST /profile/sync/pull` — changes since `req.cursor`. */
  pull(req: PullRequest): Promise<PullResponse>
  /** `POST /profile/sync/push` — apply local changes; returns applied +
   *  conflicts (stale-base rejections to re-merge). */
  push(req: PushRequest): Promise<PushResponse>
  /** `POST /profile/sync/cursor` — acknowledge the highest applied seq. */
  ackCursor(req: CursorRequest): Promise<void>
}

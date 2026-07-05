/**
 * Row types for the on-device user database. See migrations in
 * modules/apps/mobile/lectorium/services/migrations/user/ for the
 * canonical DDL.
 */

export interface NoteRow {
  readonly id: string
  readonly track_id: string
  readonly text: string
  readonly time_start: number
  readonly time_end: number
  readonly created_at: number
  /** JSON-serialised `Record<string, unknown> | null` (006_notes_meta). */
  readonly meta: string | null
}

export interface PlaylistItemRow {
  readonly id: string
  readonly track_id: string
  readonly added_at: number
  readonly archived_at: number | null
  /** Source collection (012 migration); NULL for individually-added tracks. */
  readonly collection_id: string | null
}

export interface ListeningSessionRow {
  readonly id: string
  readonly item_id: string
  readonly started_at: number
  readonly ended_at: number
  readonly from_position: number
  readonly to_position: number
}

export interface MediaItemRow {
  readonly id: string
  readonly track_id: string
  /** "original" | "clean". Older rows (pre-011 migration) have no value;
   *  the mapper defaults them to "original". */
  readonly kind: string | null
  readonly state: string
  readonly local_path: string | null
  readonly created_at: number
}

export interface UserConfigRow {
  readonly key: string
  readonly value: string
}

/**
 * Append-only journal of local changes awaiting push to the `profile` sync
 * service (013 migration). One row per upsert/delete on a synced collection,
 * written in the same transaction as the domain write by the sync-journal
 * decorator. Monotonic `id` doubles as the local cursor: rows with
 * `sent = 0` and `id` above the last pushed id are pending.
 */
export interface OutboxRow {
  /** Autoincrement rowid — the local push cursor and insertion order. */
  readonly id: number
  /** Sync collection = source `user.db` table name. */
  readonly collection: string
  /** Natural sync key (e.g. `track_id` for playlist_items). */
  readonly doc_id: string
  /** "upsert" | "delete". */
  readonly op: string
  /** JSON-serialised client-native wire row; NULL on a delete. */
  readonly data: string | null
  /** HLC string stamped on this change. */
  readonly hlc: string
  /** Last-seen server HLC the local doc derived from; NULL for a new doc /
   *  when unknown (the sync engine reconciles this before push). */
  readonly base_hlc: string | null
  /** Unix ms the row was journaled. */
  readonly created_at: number
  /** 0 = pending, 1 = acknowledged by the server. */
  readonly sent: number
}

/**
 * Per-device sync bookkeeping (013 migration). One row per device id. Tracks
 * the pull cursor (`pull_cursor`, highest applied `global_seq`), the cursor
 * acknowledged back to the server for compaction (`acked_seq`), and the
 * highest local `outbox.id` confirmed pushed (`pushed_outbox_id`).
 */
export interface SyncStateRow {
  readonly device_id: string
  readonly pull_cursor: number
  readonly acked_seq: number
  readonly pushed_outbox_id: number
  readonly updated_at: number
}

/**
 * Per-document last-seen server HLC (014 migration). One row per
 * `(collection, doc_id)`, recording the HLC the `profile` server last
 * confirmed / delivered for that document. It is the reconciliation source
 * for `outbox.base_hlc` (optimistic concurrency) and the local doc's known
 * HLC on pull-merge. Maintained by the sync engine only, never the
 * write-path.
 */
export interface SyncDocHlcRow {
  readonly collection: string
  readonly doc_id: string
  readonly server_hlc: string
}

export interface UserMigrationRow {
  readonly name: string
  /** ISO-8601 string (`new Date().toISOString()` in runMigrations). */
  readonly applied_at: string
}

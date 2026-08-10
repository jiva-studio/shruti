/**
 * Row types for the on-device user database. See migrations in
 * modules/apps/mobile/shruti/services/migrations/user/ for the
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

/**
 * Personal library membership row (017 migration). Server-owned and
 * **pull-only** — the client never writes it; the sync engine only ever
 * applies the `profile` server's version. Mirrors `profile.library_items`
 * (see docs/repos/shruti/architecture/personal-library.md § Data model).
 *
 * `id` is the per-user membership id (UUID, the sync doc_id); `track_id` is the
 * content hash, NULL until the fetch step computes it. The `*_raw` columns are
 * the lossless captured metadata; the resolved id/value columns (`author_id`,
 * `location_id`, `date`, `lang`, …) are NULL until the pipeline confidently
 * matches them. `audio_key` / `transcript_key` / `duration` are filled on
 * `ready`; `cover_key` is a re-hosted thumbnail (NULL → plain placeholder).
 */
export interface LibraryItemRow {
  readonly id: string
  readonly track_id: string | null
  /** "queued" | "processing" | "ready" | "failed". */
  readonly status: string
  /** "private" | "published"; NULL on older/partial rows. */
  readonly origin: string | null
  readonly title_raw: string | null
  readonly author_raw: string | null
  readonly location_raw: string | null
  readonly date_raw: string | null
  readonly lang_hint: string | null
  readonly author_id: string | null
  readonly location_id: string | null
  /** Resolved ISO date "YYYY-MM-DD", or NULL when unresolved. */
  readonly date: string | null
  /** ASR-detected content language — authoritative when present. */
  readonly lang: string | null
  /** User-visible failure reason on a `failed` row. */
  readonly error: string | null
  /** Full bucket key of the audio, filled on ready (e.g.
   *  "public/tracks/<track_id>/audio/original.mp3"). */
  readonly audio_key: string | null
  /** Full bucket key of the JSON transcript, filled on ready (the PRIMARY
   *  variant). */
  readonly transcript_key: string | null
  /** Per-language transcripts, stored as a JSON array
   *  `[{"lang","transcript_key"}]`; NULL on single-language / older rows. */
  readonly variants_json: string | null
  /** Audio duration in milliseconds, filled on ready. */
  readonly duration: number | null
  /** Re-hosted cover/thumbnail key; NULL → app shows a plain placeholder. */
  readonly cover_key: string | null
  /** Raw scripture references extracted from the title, stored as a JSON array
   *  `[{"source","tokens"}]`; NULL when none / older rows. */
  readonly references_json: string | null
  /** Source URL the lecture was added from; NULL on older rows. */
  readonly source_url: string | null
  readonly created_at: number | null
  readonly updated_at: number | null
}

/**
 * Personal-library membership row (021 migration) — the user's remove/re-add
 * intent, CLIENT-owned and pushed like `playlist_items`. `id` is the library
 * item id (= `library_items.id` / the membership uuid, and the sync doc_id).
 * `archived_at` NULL = active (in the library); set = removed. A row exists only
 * once the user has acted on the item — absence means active.
 */
export interface LibraryMembershipRow {
  readonly id: string
  readonly archived_at: number | null
  readonly updated_at: number | null
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
  /** The account that journaled the row (023 migration); NULL for rows written
   *  before the column existed or before an identity was resolved. Push reads
   *  only the current account's rows, so a deleted account's un-pushed changes
   *  never upload under the identity that replaces it. */
  readonly owner_id: string | null
}

/**
 * Per-device sync bookkeeping (013 migration). One row per device id. Tracks
 * the pull cursor (`pull_cursor`, highest applied `global_seq`), the cursor
 * acknowledged back to the server for compaction (`acked_seq`), and
 * `pushed_outbox_id` — the watermark below which unowned outbox rows are
 * retired, either because they were pushed or because the identity changed.
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

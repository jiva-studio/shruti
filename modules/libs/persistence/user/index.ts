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

export interface UserMigrationRow {
  readonly name: string
  /** ISO-8601 string (`new Date().toISOString()` in runMigrations). */
  readonly applied_at: string
}

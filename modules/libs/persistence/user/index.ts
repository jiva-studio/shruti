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
}

export interface PlaylistItemRow {
  readonly id: string
  readonly track_id: string
  readonly added_at: number
  readonly completed_at: number | null
  readonly archived_at: number | null
  readonly progress: number | null
}

export interface MediaItemRow {
  readonly id: string
  readonly track_id: string
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
  readonly applied_at: number
}

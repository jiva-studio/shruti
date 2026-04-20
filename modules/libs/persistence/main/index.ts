/**
 * Row types for the prebuilt content database. One type per table.
 *
 * These are implementation detail of @infra/repositories.sql — nothing
 * else in the codebase should import from here.
 */

export interface AuthorRow {
  readonly id: string
  readonly language: string
  readonly full_name: string
}

export interface LocationRow {
  readonly id: string
  readonly language: string
  readonly full_name: string
}

export interface SourceRow {
  readonly id: string
  readonly language: string
  readonly full_name: string
  readonly short_name: string
}

export interface LanguageRow {
  readonly code: string
  readonly full_name: string
  readonly icon: string | null
}

export interface TagRow {
  readonly id: string
  readonly language: string
  readonly full_name: string
}

export interface TrackRow {
  readonly id: string
  /** nullable — legacy content sometimes has no author metadata */
  readonly author_id: string | null
  /** nullable — same story for recording location */
  readonly location_id: string | null
  readonly date: string | null
  readonly hidden: number
  readonly sort_reference: string
  readonly sort_date: string
}

export interface TrackVariantRow {
  readonly track_id: string
  readonly language: string
  readonly title: string
  readonly audio_path: string | null
  readonly audio_filesize: number | null
  readonly audio_duration: number | null
  readonly audio_kind: string | null
  readonly transcript_path: string | null
  readonly transcript_kind: string | null
}

export interface TrackReferenceRow {
  readonly track_id: string
  readonly ref_idx: number
  readonly source_id: string
  /** Dot-joined numeric tail, e.g. "10.5" or "10.5.12". */
  readonly tokens: string
}

export interface TrackTagRow {
  readonly track_id: string
  readonly tag_id: string
}

export interface MigrationRow {
  readonly name: string
  readonly scheme: number | null
  readonly applied_at: number
}

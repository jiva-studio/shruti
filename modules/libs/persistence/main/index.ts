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

export interface TopicRow {
  readonly id: string
  readonly language: string
  readonly full_name: string
  readonly short_name?: string | null
  readonly cover?: string | null
}

export interface TrackRow {
  readonly id: string
  /** nullable — legacy content sometimes has no author metadata */
  readonly author_id: string | null
  /** nullable — same story for recording location */
  readonly location_id: string | null
  readonly date: string | null
  readonly hidden: number
}

export interface TrackVariantRow {
  readonly track_id: string
  readonly language: string
  readonly title: string
  readonly transcript_path: string | null
  readonly transcript_kind: string | null
  /**
   * Per-locale sort key for "by reference" mode. Format:
   *   "<localized-source-short>_<numeric-tail>"   e.g. "БГ_000001_000015" / "BG_000001_000015"
   * The leading prefix is the source's `short_name` IN THIS variant's
   * language, so an `ORDER BY sort_reference` on the variants of a given
   * locale matches the user's alphabet (Б < Ш for Russian, B < S for English).
   * NULL when the track has no scriptural reference (Morning Walks,
   * Conversations) — consumer sorts those last via `NULLS LAST`.
   */
  readonly sort_reference: string | null
  /**
   * Per-lecture section outline as a JSON array string:
   * `[{ "title": string, "start": number, "end": number }, ...]` in ms.
   * NULL until generated. Stored raw; the row mapper parses it.
   */
  readonly outline: string | null
  /** Short per-locale lecture description / overview. NULL until generated. */
  readonly description: string | null
}

/** One audio version of a (track, language) variant — see the track_audio table. */
export interface TrackAudioRow {
  readonly track_id: string
  readonly language: string
  /** "original" | "clean" | … */
  readonly kind: string
  /** Full path from the bucket root. */
  readonly path: string
  readonly filesize: number | null
  /** Audio duration in **milliseconds**. */
  readonly duration: number | null
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

export interface TrackTopicRow {
  readonly track_id: string
  readonly topic_id: string
  readonly weight: number
}

export interface MigrationRow {
  readonly name: string
  readonly scheme: number | null
  readonly applied_at: number
}

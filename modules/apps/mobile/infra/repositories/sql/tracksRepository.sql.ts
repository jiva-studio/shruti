import type { IDatabase, QueryValue } from "@ports/app/index.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type {
  ITrackRepository,
  TrackListQuery,
  TrackSearchQuery,
} from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import type {
  TrackReferenceRow,
  TrackRow,
  TrackTagRow,
  TrackVariantRow,
} from "@lib/persistence/main"
import { rowToTrack } from "./contentRowMappers.js"

/* -------------------------------------------------------------------------- */
/*                          FTS query construction                            */
/* -------------------------------------------------------------------------- */

/**
 * Turn an arbitrary user string into an FTS4 MATCH expression.
 *
 * The `unicode61` tokenizer splits on whitespace and punctuation, so
 * "bg 10.5" becomes `{bg, 10, 5}`. We tokenise the user input the
 * same way and then:
 *   - single token → bare prefix `foo*` (FTS4 Cyrillic quirk: a single
 *     quoted prefix like `"джент"*` returns nothing, but the bare
 *     form works);
 *   - multiple tokens → phrase prefix `"foo bar baz"*`. Phrase form
 *     enforces adjacency, so `1.1` doesn't sprawl into every ref
 *     starting with "1".
 */
function buildFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[\s.,;:!?()\-"'`[\]{}<>|/\\]+/)
    .map((t) => t.replace(/[^a-zа-я0-9]/gi, ""))
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return ""
  if (tokens.length === 1) return `${tokens[0]}*`
  return `"${tokens.join(" ")}"*`
}

async function hydrate(contentDb: IDatabase, tracks: readonly TrackRow[]): Promise<Track[]> {
  if (tracks.length === 0) return []
  const ids = tracks.map((t) => t.id)
  const placeholders = ids.map(() => "?").join(", ")

  const [variants, references, tags] = await Promise.all([
    contentDb.query<TrackVariantRow>(
      `SELECT * FROM track_variants WHERE track_id IN (${placeholders})`,
      ids
    ),
    contentDb.query<TrackReferenceRow>(
      `SELECT * FROM track_references WHERE track_id IN (${placeholders}) ORDER BY track_id, ref_idx`,
      ids
    ),
    contentDb.query<TrackTagRow>(
      `SELECT * FROM track_tags WHERE track_id IN (${placeholders})`,
      ids
    ),
  ])

  return tracks.map((track) => rowToTrack({ track, variants, references, tags }))
}

/**
 * Build the ORDER BY clause and the params it consumes (in slot order).
 * `byReference` looks up the per-locale `sort_reference` from track_variants
 * for the active UI language, so the chip prefix the user sees ("БГ"/"BG")
 * is what the row is bucketed by.
 */
function sortOrderClause(
  sortBy: TrackListQuery["sortBy"],
  language: LanguageCode
): { clause: string; params: QueryValue[] } {
  switch (sortBy) {
    case "byReference":
      return {
        clause: `ORDER BY (
          SELECT v.sort_reference FROM track_variants v
          WHERE v.track_id = t.id AND v.language = ?
        ) ASC, t.id ASC`,
        params: [language],
      }
    case "byDate":
    default:
      return { clause: "ORDER BY t.sort_date DESC", params: [] }
  }
}

export interface CreateSqlTrackRepositoryDeps {
  readonly contentDb: IDatabase
  /**
   * Active UI language for locale-aware sort. Reads on demand inside SQL
   * builders so a language switch reflects on the next query without
   * recreating the repo.
   */
  readonly getActiveLanguage: () => LanguageCode
}

export function createSqlTrackRepository(deps: CreateSqlTrackRepositoryDeps): ITrackRepository {
  const { contentDb, getActiveLanguage } = deps
  return {
    async getById(id: TrackId): Promise<Track | null> {
      const rows = await contentDb.query<TrackRow>(
        "SELECT * FROM tracks WHERE id = ? AND hidden = 0",
        [id]
      )
      const hydrated = await hydrate(contentDb, rows)
      return hydrated[0] ?? null
    },

    async list(query: TrackListQuery): Promise<readonly Track[]> {
      const filters = query.filters ?? {}
      const clauses: string[] = ["t.hidden = 0"]
      const params: QueryValue[] = []

      if (filters.authorIds?.length) {
        clauses.push(`t.author_id IN (${filters.authorIds.map(() => "?").join(", ")})`)
        params.push(...filters.authorIds)
      }
      if (filters.locationIds?.length) {
        clauses.push(`t.location_id IN (${filters.locationIds.map(() => "?").join(", ")})`)
        params.push(...filters.locationIds)
      }
      if (filters.tagIds?.length) {
        clauses.push(
          `t.id IN (SELECT track_id FROM track_tags WHERE tag_id IN (${filters.tagIds
            .map(() => "?")
            .join(", ")}))`
        )
        params.push(...filters.tagIds)
      }
      if (filters.languageCodes?.length) {
        clauses.push(
          `t.id IN (SELECT track_id FROM track_variants WHERE language IN (${filters.languageCodes
            .map(() => "?")
            .join(", ")}))`
        )
        params.push(...filters.languageCodes)
      }
      if (filters.durationMinMs !== undefined) {
        // Duration comes from any variant that has audio. Pick the max of
        // the per-variant durations — every variant of the same track
        // points at the same original recording for now.
        // DB column and the filter bound are both in milliseconds.
        clauses.push(
          `(SELECT COALESCE(MAX(audio_duration), 0) FROM track_variants WHERE track_id = t.id) >= ?`
        )
        params.push(filters.durationMinMs)
      }
      if (filters.durationMaxMs !== undefined) {
        clauses.push(
          `(SELECT COALESCE(MAX(audio_duration), 0) FROM track_variants WHERE track_id = t.id) < ?`
        )
        params.push(filters.durationMaxMs)
      }

      const limit = query.limit ?? 50
      const offset = query.offset ?? 0
      const sort = sortOrderClause(query.sortBy, getActiveLanguage())

      const rows = await contentDb.query<TrackRow>(
        `SELECT t.* FROM tracks t
         WHERE ${clauses.join(" AND ")}
         ${sort.clause}
         LIMIT ? OFFSET ?`,
        [...params, ...sort.params, limit, offset]
      )
      return hydrate(contentDb, rows)
    },

    async search(query: TrackSearchQuery): Promise<readonly Track[]> {
      const limit = query.limit ?? 50
      const offset = query.offset ?? 0
      const text = query.text?.trim() ?? ""
      if (text.length === 0) return []

      const fts = buildFtsQuery(text)
      if (fts.length === 0) return []

      // Single path through the unified FTS index: hits against titles
      // and all reference display variants are returned from one
      // MATCH, deduplicated at the track level.
      const lang = getActiveLanguage()
      const rows = await contentDb.query<TrackRow>(
        `SELECT DISTINCT t.* FROM tracks t
         JOIN tracks_search s ON s.track_id = t.id
         WHERE tracks_search MATCH ? AND t.hidden = 0
         ORDER BY (
           SELECT v.sort_reference FROM track_variants v
           WHERE v.track_id = t.id AND v.language = ?
         ) ASC, t.id ASC
         LIMIT ? OFFSET ?`,
        [fts, lang, limit, offset]
      )
      return hydrate(contentDb, rows)
    },

    async getTranscriptPath(trackId: TrackId, language: LanguageCode): Promise<string | null> {
      const rows = await contentDb.query<{ transcript_path: string | null }>(
        `SELECT transcript_path FROM track_variants
         WHERE track_id = ? AND language = ?
         LIMIT 1`,
        [trackId, language]
      )
      return rows[0]?.transcript_path ?? null
    },

    async listTranscriptLanguages(trackId: TrackId): Promise<readonly LanguageCode[]> {
      const rows = await contentDb.query<{ language: string }>(
        `SELECT language FROM track_variants
         WHERE track_id = ? AND transcript_path IS NOT NULL
         ORDER BY language ASC`,
        [trackId]
      )
      return rows.map((r) => r.language)
    },
  }
}

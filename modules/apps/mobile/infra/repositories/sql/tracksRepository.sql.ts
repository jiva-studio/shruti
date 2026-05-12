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
 * same way and emit an **implicit AND across prefixes** — every token
 * must appear (somewhere) in the matched row.
 *
 * The search index ships a single `combined` row per track that
 * concatenates every searchable token (titles + every reference
 * variant + locations + tags + year/month/day), so AND across fields
 * works inside that one row. See
 * `shruti-mcp/internal/infra/catalog/sqlite/write.go`
 * (rebuildTrackSearchRows).
 *
 * **Phrase queries** in double quotes are passed through to FTS as a
 * phrase match (`"life after death"` requires the tokens adjacent and
 * in order). Single-Cyrillic-token phrases stay bare-prefix to dodge
 * the FTS4 quirk where `"джент"*` returns nothing.
 *
 * Negation (`-term`) is intentionally NOT supported here — the stock
 * SQLite FTS4 build silently ignores `-term` and falls back to a
 * positive match, which would surprise users. Reach for client-side
 * filtering if exclusion is needed.
 */
function buildFtsQuery(raw: string): string {
  const pieces = splitQueryPieces(raw)
  if (pieces.length === 0) return ""
  const out: string[] = []
  for (const piece of pieces) {
    const inner = sanitizeTokens(piece.text)
    if (inner.length === 0) continue
    if (piece.phrase) {
      // Multi-token phrase → quoted FTS expression for adjacency.
      // Single token → bare prefix (FTS4 Cyrillic quirk).
      out.push(inner.length === 1 ? `${inner[0]}*` : `"${inner.join(" ")}"`)
    } else {
      for (const t of inner) out.push(`${t}*`)
    }
  }
  return out.join(" ")
}

interface QueryPiece {
  phrase: boolean
  text: string
}

/** Split raw input into quoted phrases and bare words. */
function splitQueryPieces(raw: string): QueryPiece[] {
  const out: QueryPiece[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      const text = m[1].trim()
      if (text.length > 0) out.push({ phrase: true, text })
    } else if (m[2] !== undefined) {
      out.push({ phrase: false, text: m[2] })
    }
  }
  return out
}

function sanitizeTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[\s.,;:!?()\-"'`[\]{}<>|/\\]+/)
    .map((t) => t.replace(/[^a-zа-я0-9]/gi, ""))
    .filter((t) => t.length > 0)
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
      if (filters.sourceIds?.length) {
        clauses.push(
          `t.id IN (SELECT track_id FROM track_references WHERE source_id IN (${filters.sourceIds
            .map(() => "?")
            .join(", ")}))`
        )
        params.push(...filters.sourceIds)
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

      // Single path through the unified FTS index: every track has one
      // `combined` row that concatenates every searchable token
      // (titles + reference variants + year). Scoping the join to that
      // kind makes implicit-AND across tokens AND across kinds work in
      // one MATCH — e.g. `"BG 1974 2.12"` succeeds because all three
      // tokens appear in the same combined row.
      const lang = getActiveLanguage()
      const rows = await contentDb.query<TrackRow>(
        `SELECT t.* FROM tracks t
         JOIN tracks_search s ON s.track_id = t.id AND s.kind = 'combined'
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

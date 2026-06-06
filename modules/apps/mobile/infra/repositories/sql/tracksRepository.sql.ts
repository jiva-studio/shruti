import type { IDatabase, QueryValue } from "@ports/app/index.js"
import type { LanguageCode, SourceId, TrackId } from "@lib/domain/core.js"
import type {
  ITrackRepository,
  TrackListFilters,
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
 * **Reference patterns** like `2.13` or `1.1.2` (multi-component
 * dotted numbers) are auto-promoted to FTS phrase matches: `2.13` →
 * `"2 13"`, `1.1.2` → `"1 1 2"`. Without this, FTS4 would tokenise
 * `2.13` into `{2, 13}` and prefix-AND `2* 13*` would match any
 * reference starting with 2 plus any reference starting with 13
 * (so `bg 2.13` would surface BG 13.21, BG 4.24, etc. before BG 2.13).
 * A single all-digit token (a bare year like `1974`) stays a prefix
 * — only dotted patterns get the phrase treatment.
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
export function buildFtsQuery(raw: string): string {
  const pieces = splitQueryPieces(raw)
  if (pieces.length === 0) return ""
  const out: string[] = []
  for (const piece of pieces) {
    if (piece.phrase) {
      // User-quoted phrase: tokenise (split on punctuation, lower-case)
      // and emit as an FTS phrase. Single-token phrases stay bare
      // prefix to dodge the FTS4 Cyrillic quirk.
      const inner = sanitizeTokens(piece.text)
      if (inner.length === 0) continue
      out.push(inner.length === 1 ? `${inner[0]}*` : `"${inner.join(" ")}"`)
      continue
    }
    // Bare word. If it's a multi-component reference (`2.13`,
    // `1.1.2`), promote to a phrase so FTS enforces adjacency on the
    // numeric components. Otherwise tokenise and emit prefixes as
    // before.
    if (REFERENCE_PATTERN.test(piece.text)) {
      const parts = piece.text.split(".")
      out.push(`"${parts.join(" ")}"`)
      continue
    }
    const inner = sanitizeTokens(piece.text)
    if (inner.length === 0) continue
    for (const t of inner) out.push(`${t}*`)
  }
  return out.join(" ")
}

/**
 * Matches a multi-component numeric reference like `2.13` or `1.1.2`.
 * A bare year (`1974`) does NOT match — only dotted patterns.
 */
const REFERENCE_PATTERN = /^\d+(?:\.\d+)+$/

/**
 * Hard cap on rows scored by JS. FTS4 returns matches in no specific
 * order so this is a coarse "first N matches" bound; vague prefix
 * queries (`bg*`, `1*`) that hit >SCORE_CAP rows lose the tail. Picked
 * to keep the JS-bridge JSON payload (id + date + matchinfo blob per
 * row) under ~100 KB on Android, where Capacitor-SQLite serializes
 * blobs as comma-separated decimal byte arrays.
 */
const SCORE_CAP = 500

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
 * Sorts use `NULLS LAST` so tracks with no shloka (no per-locale
 * `track_variants.sort_reference`) or no date land at the end regardless
 * of direction.
 *
 * `byReference` looks up the per-locale `sort_reference` from
 * `track_variants` for the active UI language, so the chip prefix the
 * user sees ("БГ"/"BG") is what the row is bucketed by. Cross tiebreak
 * by date DESC; tracks without a reference fall to the tail and within
 * that tail sort by date DESC for free.
 *
 * `byDateDesc` / `byDateAsc` sort directly on `tracks.date` — the stored
 * "YYYY-MM-DD" string compares chronologically under SQLite's BINARY
 * collation, so no separate sort cache is needed. Cross tiebreak by
 * reference ASC.
 */
function sortOrderClause(
  sortBy: TrackListQuery["sortBy"],
  language: LanguageCode
): { clause: string; params: QueryValue[] } {
  const refSubq = `(
    SELECT v.sort_reference FROM track_variants v
    WHERE v.track_id = t.id AND v.language = ?
  )`
  switch (sortBy) {
    case "byReference":
      return {
        clause: `ORDER BY ${refSubq} ASC NULLS LAST,
                          t.date DESC NULLS LAST,
                          t.id ASC`,
        params: [language],
      }
    case "byDateAsc":
      return {
        clause: `ORDER BY t.date ASC NULLS LAST,
                          ${refSubq} ASC NULLS LAST,
                          t.id ASC`,
        params: [language],
      }
    case "byDateDesc":
    default:
      return {
        clause: `ORDER BY t.date DESC NULLS LAST,
                          ${refSubq} ASC NULLS LAST,
                          t.id ASC`,
        params: [language],
      }
  }
}

/* -------------------------------------------------------------------------- */
/*                       FTS relevance scoring helpers                        */
/* -------------------------------------------------------------------------- */

/**
 * Decode FTS4 `matchinfo(s, 'pcx')` blob and compute a relevance
 * score for a single matched row.
 *
 * The blob is a sequence of little-endian 32-bit unsigned ints:
 *   [p, c,
 *    (hits_in_row, hits_in_corpus, rows_with_term)  for each phrase × column]
 *
 * Score formula (one-term BM25 without saturation; cheap and good
 * enough at low-thousands corpus scale):
 *
 *   score = Σ over (phrase, column):
 *             hits_in_row × log((N + 1) / max(1, rows_with_term))
 *
 * Notindexed columns return 0 hits across the board, so they
 * contribute nothing to the score even though they show up in the
 * blob — no need to filter them out explicitly.
 *
 * If the blob is missing/malformed (defensive — shouldn't happen in
 * practice), returns 0 so the row still surfaces, just unranked.
 */
/**
 * Adapter shapes for a SQLite BLOB column observed in this project:
 *   - `Uint8Array` — sql.js (web) and any IDatabase that hands raw bytes through.
 *   - `number[]` — @capacitor-community/sqlite on Android (`ByteArrayToJSArray`)
 *     and iOS (`data.bytes` → `[UInt8]`); the bytes arrive JSON-serialized as a
 *     plain JS array.
 *   - base64 `string` — alternate path documented in the same plugin.
 *
 * Normalising here keeps consumers (matchinfo scoring) shape-agnostic; we can't
 * fix the producer because it's a third-party native plugin.
 */
export type SqlBlob = Uint8Array | number[] | string | null | undefined

export function normalizeBlob(value: SqlBlob): Uint8Array | null {
  if (value == null) return null
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return Uint8Array.from(value)
  if (typeof value === "string") {
    try {
      const bin = atob(value)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    } catch {
      return null
    }
  }
  return null
}

export function scoreMatchinfo(raw: SqlBlob, totalDocs: number): number {
  const blob = normalizeBlob(raw)
  if (!blob || blob.byteLength < 8) return 0
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const u32 = (i: number): number => view.getUint32(i * 4, true)
  const p = u32(0)
  const c = u32(1)
  if (p === 0 || c === 0) return 0
  const expected = 2 + p * c * 3
  if (blob.byteLength < expected * 4) return 0

  const idfCap = Math.log((totalDocs + 1) / 1) // upper bound on IDF
  let score = 0
  for (let phrase = 0; phrase < p; phrase++) {
    for (let col = 0; col < c; col++) {
      const base = 2 + (phrase * c + col) * 3
      const hitsInRow = u32(base)
      const rowsWithTerm = u32(base + 2)
      if (hitsInRow === 0) continue
      const idf = rowsWithTerm > 0 ? Math.log((totalDocs + 1) / rowsWithTerm) : idfCap
      score += hitsInRow * idf
    }
  }
  return score
}

/**
 * Build the WHERE-clause fragments and bound parameters for a
 * `TrackListFilters` value. Shared between `list()` and `search()` so
 * filter narrowing happens in SQL, not after pagination.
 *
 * Clauses target the `tracks t` alias and assume the caller has
 * already added `t.hidden = 0`. Returns a flat array of additive
 * predicates joined by AND.
 */
function buildFilterClauses(filters: TrackListFilters): {
  readonly clauses: readonly string[]
  readonly params: readonly QueryValue[]
} {
  const clauses: string[] = []
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
  // `tracks.date` is a "YYYY-MM-DD" string; BINARY collation makes string
  // comparison chronological, so the precomputed bounds compare directly.
  if (filters.dateGte !== undefined) {
    clauses.push(`t.date >= ?`)
    params.push(filters.dateGte)
  }
  if (filters.dateLt !== undefined) {
    clauses.push(`t.date < ?`)
    params.push(filters.dateLt)
  }

  return { clauses, params }
}

/**
 * Number of `combined` search rows = number of indexed tracks. Used
 * as the corpus size N in the IDF term. Cached per query (cheap
 * count, runs once).
 */
async function getCombinedRowCount(contentDb: IDatabase): Promise<number> {
  const rows = await contentDb.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tracks_search WHERE kind = 'combined'`
  )
  return rows[0]?.n ?? 0
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

    async getByIds(ids: readonly TrackId[]): Promise<ReadonlyMap<TrackId, Track>> {
      const result = new Map<TrackId, Track>()
      if (ids.length === 0) return result
      const placeholders = ids.map(() => "?").join(", ")
      const rows = await contentDb.query<TrackRow>(
        `SELECT * FROM tracks WHERE id IN (${placeholders}) AND hidden = 0`,
        [...ids]
      )
      const hydrated = await hydrate(contentDb, rows)
      for (const track of hydrated) result.set(track.id, track)
      return result
    },

    async findByReference(sourceId: SourceId, tokens: readonly string[]): Promise<Track | null> {
      // Tokens are stored as the dot-joined string in `track_references.tokens`
      // (see TrackReferenceRow). Reconstruct that representation here so the
      // SQL stays an indexed equality lookup rather than a substring scan.
      const tokenKey = tokens.join(".")
      const rows = await contentDb.query<TrackRow>(
        `SELECT t.* FROM tracks t
           JOIN track_references r ON r.track_id = t.id
          WHERE r.source_id = ? AND r.tokens = ? AND t.hidden = 0
          LIMIT 1`,
        [sourceId, tokenKey]
      )
      const hydrated = await hydrate(contentDb, rows)
      return hydrated[0] ?? null
    },

    async list(query: TrackListQuery): Promise<readonly Track[]> {
      const filterParts = buildFilterClauses(query.filters ?? {})
      const clauses = ["t.hidden = 0", ...filterParts.clauses]

      const limit = query.limit ?? 50
      const offset = query.offset ?? 0
      const sort = sortOrderClause(query.sortBy, getActiveLanguage())

      const rows = await contentDb.query<TrackRow>(
        `SELECT t.* FROM tracks t
         WHERE ${clauses.join(" AND ")}
         ${sort.clause}
         LIMIT ? OFFSET ?`,
        [...filterParts.params, ...sort.params, limit, offset]
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

      const filterParts = buildFilterClauses(query.filters ?? {})
      const filterSql = filterParts.clauses.length
        ? ` AND ${filterParts.clauses.join(" AND ")}`
        : ""

      // Two-stage query: (1) FTS subquery emits the top SCORE_CAP
      // candidate `combined` rows with their matchinfo blob, bounded
      // so the virtual table stops yielding immediately — this is the
      // fix for the device-side 1-7 s floor caused by the old JOIN
      // form draining the full match set before LIMIT could clip it;
      // (2) the outer query joins to `tracks`, applies hidden + user
      // filters, ships back narrow `id + date + __minfo` rows for JS
      // ranking. The page slice is hydrated below via a second SQL
      // call so callers get full Track objects.
      //
      // SCORE_CAP is intentionally an over-fetch — `hidden=0` and
      // user filters drop rows from the FTS candidate set, so
      // requesting page_size matches inside FTS would leave the page
      // short. At SCORE_CAP=500 we can safely page up to a few
      // hundred results without drift; queries with more matches
      // than that lose the tail (rank-irrelevant in practice).
      //
      // Relevance: FTS4 `matchinfo(s, 'pcx')` returns a BLOB of 32-bit
      // LE ints — `[p, c, hits_in_row, hits_in_corpus, rows_with_term, …]`
      // — three ints per (phrase × column). We compute a one-term
      // BM25-without-saturation score in JS:
      //     score = Σ hits_in_row × log((N+1) / max(1, rows_with_term))
      // and sort DESC, breaking ties by `t.date DESC, t.id ASC`.
      type ScoreRow = { id: TrackId; date: string | null; __minfo: SqlBlob }
      const rawRows = await contentDb.query<ScoreRow>(
        `SELECT t.id, t.date, sub.__minfo
         FROM tracks t
         JOIN (
           SELECT track_id, matchinfo(tracks_search, 'pcx') AS __minfo
           FROM tracks_search
           WHERE tracks_search MATCH ? AND kind = 'combined'
           LIMIT ?
         ) sub ON sub.track_id = t.id
         WHERE t.hidden = 0${filterSql}`,
        [fts, SCORE_CAP, ...filterParts.params]
      )
      if (rawRows.length === 0) return []

      const totalDocs = await getCombinedRowCount(contentDb)
      const scored = rawRows.map((row) => ({
        id: row.id,
        date: row.date,
        score: scoreMatchinfo(row.__minfo, totalDocs),
      }))
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        const ad = a.date ?? ""
        const bd = b.date ?? ""
        if (ad !== bd) return bd < ad ? -1 : 1
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })

      const pageIds = scored.slice(offset, offset + limit).map((r) => r.id)
      if (pageIds.length === 0) return []

      const placeholders = pageIds.map(() => "?").join(", ")
      const fullRows = await contentDb.query<TrackRow>(
        `SELECT * FROM tracks WHERE id IN (${placeholders}) AND hidden = 0`,
        [...pageIds]
      )
      const hydrated = await hydrate(contentDb, fullRows)
      const byId = new Map(hydrated.map((t) => [t.id, t]))
      return pageIds.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
    },

    async listYears(): Promise<readonly number[]> {
      // Distinct 4-digit year prefix of the date string, newest first.
      // Empty/null dates are excluded so the picker never offers a blank.
      const rows = await contentDb.query<{ y: string }>(
        `SELECT DISTINCT substr(date, 1, 4) AS y
           FROM tracks
          WHERE hidden = 0 AND date IS NOT NULL AND date != ''
          ORDER BY y DESC`
      )
      return rows.map((r) => Number(r.y)).filter((y) => Number.isInteger(y) && y > 0)
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

    async getDurationsMs(trackIds: readonly TrackId[]): Promise<ReadonlyMap<TrackId, number>> {
      const out = new Map<TrackId, number>()
      if (trackIds.length === 0) return out
      // GROUP BY + MAX picks the longest variant per track. Variants
      // typically differ in language but share audio length within a few
      // hundred ms; MAX is the conservative pick when they don't.
      const placeholders = trackIds.map(() => "?").join(",")
      const rows = await contentDb.query<{
        track_id: string
        duration: number | null
      }>(
        `SELECT track_id, MAX(audio_duration) AS duration
           FROM track_variants
          WHERE track_id IN (${placeholders})
          GROUP BY track_id`,
        [...trackIds]
      )
      for (const r of rows) {
        if (r.duration !== null) out.set(r.track_id as TrackId, Number(r.duration))
      }
      return out
    },
  }
}

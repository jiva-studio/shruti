import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode, SourceId, TrackId } from "@lib/domain/core.js"
import type {
  ITrackRepository,
  TrackListFilters,
  TrackListQuery,
  TrackSearchQuery,
} from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackAudioRow, TrackRow } from "@lib/persistence/main"
import { buildFtsQuery } from "./ftsQuery.js"
import { hydrateTracks } from "./trackHydration.js"
import { buildFilterClauses, sortOrderClause } from "./trackQueryClauses.js"
import { largestPlayableSizes } from "./trackAudioSizes.js"
import { searchScored, searchSorted } from "./trackSearchQueries.js"

/**
 * Ids per `IN (...)` batch when sizing the offline cache. That id list is
 * "every downloaded track", which can outgrow SQLite's bound-parameter
 * ceiling (999 on older builds) — the other queries here are page-bounded.
 */
const SIZE_QUERY_CHUNK = 500

export interface CreateSqlTrackRepositoryDeps {
  readonly contentDb: IDatabase
  /**
   * Active UI language for locale-aware sort. Read on demand inside the SQL
   * builders so a language switch reflects on the next query without
   * recreating the repo.
   */
  readonly getActiveLanguage: () => LanguageCode
}

export function createSqlTrackRepository(deps: CreateSqlTrackRepositoryDeps): ITrackRepository {
  const { contentDb, getActiveLanguage } = deps

  /** The filter-only catalog listing. Hoisted out of the `list` member so
   *  `search` can fall back to it without going through `this`. */
  async function listTracks(query: TrackListQuery): Promise<readonly Track[]> {
    const filters = buildFilterClauses(query.filters ?? {})
    const clauses = ["t.hidden = 0", ...filters.clauses]
    const sort = sortOrderClause(query.sortBy, getActiveLanguage())

    const rows = await contentDb.query<TrackRow>(
      `SELECT t.* FROM tracks t
         WHERE ${clauses.join(" AND ")}
         ${sort.clause}
         LIMIT ? OFFSET ?`,
      [...filters.params, ...sort.params, query.limit ?? 50, query.offset ?? 0]
    )
    return hydrateTracks(contentDb, rows)
  }

  async function readAudioRows(trackIds: readonly TrackId[]): Promise<TrackAudioRow[]> {
    const rows: TrackAudioRow[] = []
    for (let i = 0; i < trackIds.length; i += SIZE_QUERY_CHUNK) {
      const chunk = trackIds.slice(i, i + SIZE_QUERY_CHUNK)
      const placeholders = chunk.map(() => "?").join(",")
      rows.push(
        ...(await contentDb.query<TrackAudioRow>(
          `SELECT * FROM track_audio WHERE track_id IN (${placeholders})`,
          [...chunk]
        ))
      )
    }
    return rows
  }

  return {
    async getById(id: TrackId): Promise<Track | null> {
      const rows = await contentDb.query<TrackRow>(
        "SELECT * FROM tracks WHERE id = ? AND hidden = 0",
        [id]
      )
      const hydrated = await hydrateTracks(contentDb, rows)
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
      for (const track of await hydrateTracks(contentDb, rows)) result.set(track.id, track)
      return result
    },

    async findByReference(
      sourceId: SourceId,
      tokens: readonly string[],
      languages?: readonly LanguageCode[]
    ): Promise<Track | null> {
      // Tokens are stored dot-joined in `track_references.tokens`; rebuilding
      // that here keeps the SQL an indexed equality lookup, not a scan.
      const tokenKey = tokens.join(".")
      // With library languages set, require a variant in one of them so the
      // arbitrary LIMIT 1 cannot return an off-language lecture. Empty = any.
      const langParams = languages?.length ? languages : []
      const langFilter = langParams.length
        ? ` AND EXISTS (SELECT 1 FROM track_variants v
                        WHERE v.track_id = t.id
                          AND v.language IN (${langParams.map(() => "?").join(",")}))`
        : ""
      const rows = await contentDb.query<TrackRow>(
        `SELECT t.* FROM tracks t
           JOIN track_references r ON r.track_id = t.id
          WHERE r.source_id = ? AND r.tokens = ? AND t.hidden = 0${langFilter}
          LIMIT 1`,
        [sourceId, tokenKey, ...langParams]
      )
      const hydrated = await hydrateTracks(contentDb, rows)
      return hydrated[0] ?? null
    },

    list: listTracks,

    async search(query: TrackSearchQuery): Promise<readonly Track[]> {
      const text = query.text?.trim() ?? ""
      if (text.length === 0) return []

      const fts = buildFtsQuery(text)
      if (fts.length === 0) {
        // The text tokenised to nothing — `?`, `*`, `""`, an em-dash, an
        // emoji. That is a query carrying no searchable content, like the
        // empty box, which already routes down the `list` path; returning the
        // filtered catalog keeps the two in agreement. The repository could
        // not signal the difference anyway — both cases come back empty.
        return listTracks({
          filters: query.filters,
          sortBy: query.sortBy,
          limit: query.limit,
          offset: query.offset,
        })
      }

      const filters = buildFilterClauses(query.filters ?? {})
      const filterSql = filters.clauses.length ? ` AND ${filters.clauses.join(" AND ")}` : ""
      const ctx = { contentDb, fts, filters, filterSql }
      if (!query.sortBy) return searchScored(ctx, query)
      return searchSorted(ctx, query, sortOrderClause(query.sortBy, getActiveLanguage()))
    },

    async count(filters?: TrackListFilters): Promise<number> {
      const filterParts = buildFilterClauses(filters ?? {})
      const clauses = ["t.hidden = 0", ...filterParts.clauses]
      const rows = await contentDb.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tracks t WHERE ${clauses.join(" AND ")}`,
        [...filterParts.params]
      )
      return rows[0]?.n ?? 0
    },

    async listYears(): Promise<readonly number[]> {
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
      // Versions/variants typically share audio length within a few hundred
      // ms; MAX is the conservative pick when they don't.
      const placeholders = trackIds.map(() => "?").join(",")
      const rows = await contentDb.query<{ track_id: string; duration: number | null }>(
        `SELECT track_id, MAX(duration) AS duration
           FROM track_audio
          WHERE track_id IN (${placeholders})
          GROUP BY track_id`,
        [...trackIds]
      )
      for (const r of rows) {
        if (r.duration !== null) out.set(r.track_id as TrackId, Number(r.duration))
      }
      return out
    },

    async getAudioSizesBytes(trackIds: readonly TrackId[]): Promise<ReadonlyMap<TrackId, number>> {
      if (trackIds.length === 0) return new Map<TrackId, number>()
      // Sizes come from `track_audio`, never from the legacy
      // `track_variants.audio_filesize` — that column carries the ORIGINAL
      // file's size and is stale for every track that has a denoised version,
      // which is exactly the version the app downloads.
      return largestPlayableSizes(await readAudioRows(trackIds))
    },
  }
}

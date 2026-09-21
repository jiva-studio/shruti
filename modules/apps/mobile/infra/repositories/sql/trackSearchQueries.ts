import type { IDatabase, QueryValue } from "@ports/app/index.js"
import type { TrackSearchQuery } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackRow } from "@lib/persistence/main"
import { rankSearchRows, type ScoredSearchRow } from "./matchinfoScore.js"
import { hydrateTracks } from "./trackHydration.js"
import type { SqlFragment } from "./trackQueryClauses.js"

/**
 * Rows scored by JS. FTS4 returns matches in no particular order, so this is a
 * coarse "first N matches" bound: a vague prefix query loses the tail. Sized
 * to keep the JS-bridge payload under ~100 KB on Android, where
 * Capacitor-SQLite serializes blobs as comma-separated decimal byte arrays.
 */
const SCORE_CAP = 500

/**
 * Match set the SQL-sorted branch pages over. Applied *after* the sort, so it
 * keeps the first N in the order the user asked for and can only cost the tail
 * of a very broad query. The bound is what stops SQLite's sorter growing with
 * the corpus on every page fetch.
 */
const SORTED_CAP = 5000

export interface SearchContext {
  readonly contentDb: IDatabase
  readonly fts: string
  readonly filters: SqlFragment
  /** The filter clauses, pre-joined and AND-prefixed, or empty. */
  readonly filterSql: string
}

/** Indexed tracks, i.e. the corpus size N in the IDF term. */
async function countIndexedTracks(contentDb: IDatabase): Promise<number> {
  const rows = await contentDb.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tracks_search WHERE kind = 'combined'`
  )
  return rows[0]?.n ?? 0
}

/**
 * A sort the user asked for is decided by SQL, exactly as the plain listing
 * does it, with FTS membership as one more condition — ordering by shloka
 * needs a subquery the scored path has no column for.
 *
 * The cap sits *inside* the sort: bounding the bare membership subquery would
 * hand the ORDER BY an arbitrary FTS-docid slice, and dropping the bound would
 * put the whole match set through LIMIT/OFFSET once per page.
 */
export async function searchSorted(
  ctx: SearchContext,
  query: TrackSearchQuery,
  sort: { clause: string; params: QueryValue[] }
): Promise<readonly Track[]> {
  const params: QueryValue[] = [
    ctx.fts,
    ...ctx.filters.params,
    ...sort.params,
    SORTED_CAP,
    ...sort.params,
    query.limit ?? 50,
    query.offset ?? 0,
  ]
  const rows = await ctx.contentDb.query<TrackRow>(
    `SELECT * FROM (
       SELECT t.* FROM tracks t
        WHERE t.id IN (
                SELECT track_id FROM tracks_search
                WHERE tracks_search MATCH ? AND kind = 'combined'
              )
          AND t.hidden = 0${ctx.filterSql}
        ${sort.clause}
        LIMIT ?
     ) t
     ${sort.clause}
     LIMIT ? OFFSET ?`,
    params
  )
  return hydrateTracks(ctx.contentDb, rows)
}

/**
 * Relevance order, for a caller that asked for no sort at all. Two stages: the
 * FTS subquery yields at most SCORE_CAP candidates with their matchinfo blob,
 * bounded so the virtual table stops yielding immediately; the outer query
 * applies hidden + user filters and ships narrow rows back for JS ranking.
 * SCORE_CAP is an over-fetch on purpose — the filters drop rows, so asking FTS
 * for one page's worth would leave the page short.
 */
export async function searchScored(
  ctx: SearchContext,
  query: TrackSearchQuery
): Promise<readonly Track[]> {
  const rawRows = await ctx.contentDb.query<ScoredSearchRow>(
    `SELECT t.id, t.date, sub.__minfo
     FROM tracks t
     JOIN (
       SELECT track_id, matchinfo(tracks_search, 'pcx') AS __minfo
       FROM tracks_search
       WHERE tracks_search MATCH ? AND kind = 'combined'
       LIMIT ?
     ) sub ON sub.track_id = t.id
     WHERE t.hidden = 0${ctx.filterSql}`,
    [ctx.fts, SCORE_CAP, ...ctx.filters.params]
  )
  if (rawRows.length === 0) return []

  const ranked = rankSearchRows(rawRows, await countIndexedTracks(ctx.contentDb))
  const offset = query.offset ?? 0
  const pageIds = ranked.slice(offset, offset + (query.limit ?? 50))
  if (pageIds.length === 0) return []

  const placeholders = pageIds.map(() => "?").join(", ")
  const fullRows = await ctx.contentDb.query<TrackRow>(
    `SELECT * FROM tracks WHERE id IN (${placeholders}) AND hidden = 0`,
    [...pageIds]
  )
  const byId = new Map((await hydrateTracks(ctx.contentDb, fullRows)).map((t) => [t.id, t]))
  return pageIds.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
}

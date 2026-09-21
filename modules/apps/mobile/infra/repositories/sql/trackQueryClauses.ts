import type { QueryValue } from "@ports/app/index.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { TrackListFilters, TrackListQuery } from "@lib/domain/ports/trackRepository.js"

/** Duration comes from any audio version of any variant — every version of a
 *  track is the same recording length, so the max is the track's. */
const AUDIO_DURATION = `(SELECT COALESCE(MAX(duration), 0) FROM track_audio WHERE track_id = t.id)`

function memberOf(table: string, column: string, slots: string): string {
  return `t.id IN (SELECT track_id FROM ${table} WHERE ${column} IN (${slots}))`
}

type IdFilterKey =
  | "authorIds"
  | "locationIds"
  | "tagIds"
  | "topicIds"
  | "languageCodes"
  | "sourceIds"

type RangeFilterKey = "durationMinMs" | "durationMaxMs" | "dateGte" | "dateLt"

const ID_FILTERS: readonly { key: IdFilterKey; clause: (slots: string) => string }[] = [
  { key: "authorIds", clause: (s) => `t.author_id IN (${s})` },
  { key: "locationIds", clause: (s) => `t.location_id IN (${s})` },
  { key: "tagIds", clause: (s) => memberOf("track_tags", "tag_id", s) },
  { key: "topicIds", clause: (s) => memberOf("track_topics", "topic_id", s) },
  { key: "languageCodes", clause: (s) => memberOf("track_variants", "language", s) },
  { key: "sourceIds", clause: (s) => memberOf("track_references", "source_id", s) },
]

// `tracks.date` is a "YYYY-MM-DD" string; BINARY collation makes string
// comparison chronological, so the precomputed bounds compare directly.
const RANGE_FILTERS: readonly { key: RangeFilterKey; clause: string }[] = [
  { key: "durationMinMs", clause: `${AUDIO_DURATION} >= ?` },
  { key: "durationMaxMs", clause: `${AUDIO_DURATION} < ?` },
  { key: "dateGte", clause: `t.date >= ?` },
  { key: "dateLt", clause: `t.date < ?` },
]

export interface SqlFragment {
  readonly clauses: readonly string[]
  readonly params: readonly QueryValue[]
}

/**
 * Additive WHERE predicates for a `TrackListFilters`, joined by AND. Shared
 * between `list()` and `search()` so filter narrowing happens in SQL, not
 * after pagination. Clauses target the `tracks t` alias and assume the caller
 * has already added `t.hidden = 0`.
 */
export function buildFilterClauses(filters: TrackListFilters): SqlFragment {
  const clauses: string[] = []
  const params: QueryValue[] = []

  for (const filter of ID_FILTERS) {
    const values = filters[filter.key]
    if (!values?.length) continue
    clauses.push(filter.clause(values.map(() => "?").join(", ")))
    params.push(...values)
  }
  for (const filter of RANGE_FILTERS) {
    const value = filters[filter.key]
    if (value === undefined) continue
    clauses.push(filter.clause)
    params.push(value)
  }

  return { clauses, params }
}

/**
 * The ORDER BY clause and the params it consumes, in slot order. `NULLS LAST`
 * puts tracks with no shloka or no date at the end whichever way the sort runs.
 *
 * `byReference` reads the per-locale `track_variants.sort_reference` for the
 * active UI language, so the chip prefix the user sees ("БГ"/"BG") is what the
 * row is bucketed by.
 */
export function sortOrderClause(
  sortBy: TrackListQuery["sortBy"],
  language: LanguageCode
): { clause: string; params: QueryValue[] } {
  const refSubq = `(
    SELECT v.sort_reference FROM track_variants v
    WHERE v.track_id = t.id AND v.language = ?
  )`
  const orders: Record<string, string> = {
    byReference: `ORDER BY ${refSubq} ASC NULLS LAST,
                          t.date DESC NULLS LAST,
                          t.id ASC`,
    byDateAsc: `ORDER BY t.date ASC NULLS LAST,
                          ${refSubq} ASC NULLS LAST,
                          t.id ASC`,
    byDateDesc: `ORDER BY t.date DESC NULLS LAST,
                          ${refSubq} ASC NULLS LAST,
                          t.id ASC`,
  }
  return { clause: orders[sortBy ?? ""] ?? orders.byDateDesc, params: [language] }
}

/**
 * Date-range filter for the Search view. Both bounds are optional and each
 * bound is a coarse `"YYYY"` or `"YYYY-MM"` string (day granularity is
 * intentionally not offered). A month is only ever present alongside its
 * year — the UI gates the month picker on a chosen year, so `"03"` alone is
 * never representable.
 *
 * `tracks.date` is stored as a `"YYYY-MM-DD"` string and compares
 * chronologically under SQLite's BINARY collation, so the bounds below are
 * plain string comparisons: `date >= gte AND date < lt`.
 */

/** A single edge of the range as picked in the UI. `undefined` = open end. */
export type DateBound = string | undefined

export interface DateRangeBounds {
  /** Inclusive lower bound, `"YYYY-MM-DD"`. Absent = unbounded below. */
  readonly gte?: string
  /** Exclusive upper bound, `"YYYY-MM-DD"`. Absent = unbounded above. */
  readonly lt?: string
}

/** Parse `"YYYY"` / `"YYYY-MM"` into numeric parts, or `null` if malformed. */
function parseBound(bound: DateBound): { year: number; month?: number } | null {
  if (!bound) return null
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(bound)
  if (!m) return null
  const year = Number(m[1])
  const month = m[2] !== undefined ? Number(m[2]) : undefined
  if (month !== undefined && (month < 1 || month > 12)) return null
  return { year, month }
}

const pad = (n: number): string => String(n).padStart(2, "0")

/**
 * Convert the two UI bounds into the inclusive-lower / exclusive-upper
 * `"YYYY-MM-DD"` pair the repository filters on. The upper bound is made
 * exclusive of the *next* period so `to = "2012"` includes all of 2012 and
 * `to = "2012-06"` includes all of June 2012.
 */
export function dateRangeBounds(from: DateBound, to: DateBound): DateRangeBounds {
  const out: { gte?: string; lt?: string } = {}

  const lower = parseBound(from)
  if (lower) {
    out.gte = `${lower.year}-${pad(lower.month ?? 1)}-01`
  }

  const upper = parseBound(to)
  if (upper) {
    if (upper.month === undefined) {
      // Whole year: first day of the following year.
      out.lt = `${upper.year + 1}-01-01`
    } else if (upper.month === 12) {
      out.lt = `${upper.year + 1}-01-01`
    } else {
      out.lt = `${upper.year}-${pad(upper.month + 1)}-01`
    }
  }

  return out
}

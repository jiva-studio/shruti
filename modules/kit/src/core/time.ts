/**
 * Local-timezone date helpers for activity/streak/heatmap logic.
 * All math is DST-safe by going through `Date` setters.
 */

/** Milliseconds in a nominal day. Use day-bucketing helpers for DST-correct math. */
export const MS_PER_DAY = 86_400_000

/** Timestamp (ms) of local midnight for the day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** `YYYY-MM-DD` in local time for a timestamp (ms) or Date. */
export function toIsoDate(input: number | Date): string {
  const d = typeof input === "number" ? new Date(input) : input
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** Add `days` (may be negative) to `ms`, DST-safe, returning a new timestamp. */
export function addDays(ms: number, days: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

/** Whole local-day difference (`b` − `a`), counting calendar days crossed. */
export function daysBetween(a: number, b: number): number {
  return Math.round((startOfLocalDay(b) - startOfLocalDay(a)) / MS_PER_DAY)
}

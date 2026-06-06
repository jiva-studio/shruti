const MONTHS_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/**
 * Locale-aware display for a track's recording date. A full ISO date
 * becomes `DD.MM.YYYY` (ru) or `D Mon YYYY` (en); anything that isn't a
 * full `YYYY-MM-DD` (a year-only value, or an empty string) passes
 * through unchanged — many lectures only carry a year.
 *
 * Mirrors the formatter already used in the chat TrackMiniRow so the same
 * date reads identically across surfaces.
 */
export function formatTrackDate(date: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  const [, y, mo, day] = m
  if (locale === "ru") return `${day}.${mo}.${y}`
  const i = Math.max(0, Math.min(11, Number(mo) - 1))
  return `${Number(day)} ${MONTHS_EN[i]} ${y}`
}

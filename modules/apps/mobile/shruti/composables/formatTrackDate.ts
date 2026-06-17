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

// Cache one Intl.DateTimeFormat per locale — constructing it is relatively
// expensive and track lists render many dates.
const monthFormatters = new Map<string, Intl.DateTimeFormat>()

function localizedMonth(locale: string, monthIndex: number): string {
  let fmt = monthFormatters.get(locale)
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat(locale, { month: "short" })
    } catch {
      fmt = undefined
    }
    if (!fmt) return MONTHS_EN[monthIndex]
    monthFormatters.set(locale, fmt)
  }
  // Day 15 keeps us clear of any month-boundary timezone drift.
  return fmt.format(new Date(Date.UTC(2000, monthIndex, 15)))
}

/**
 * Locale-aware display for a track's recording date. A full ISO date
 * becomes `DD.MM.YYYY` (ru) or `D Mon YYYY` (en and every other locale,
 * with `Mon` localized via `Intl`); anything that isn't a full
 * `YYYY-MM-DD` (a year-only value, or an empty string) passes through
 * unchanged — many lectures only carry a year.
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
  const month = locale === "en" ? MONTHS_EN[i] : localizedMonth(locale, i)
  return `${Number(day)} ${month} ${y}`
}

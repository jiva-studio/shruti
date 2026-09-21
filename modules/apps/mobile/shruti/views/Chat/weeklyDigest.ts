export interface DailyTotal {
  readonly dayOffset: number
  readonly listenedSeconds: number
}

export interface ChartDay {
  readonly label: string
  readonly listenedSeconds: number
  readonly isToday: boolean
}

const DAY_MS = 86_400_000

function isoDate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * A fixed seven-column chart from `fromMs`, gaps filled with zero.
 *
 * Bars are keyed by day offset from `fromMs` — the anchor the totals are
 * bucketed against — so they never depend on a calendar-date string lining up
 * across the SQLite/JS timezone boundary.
 */
export function buildChartDays(
  dailyTotals: readonly DailyTotal[],
  fromMs: number,
  nowMs: number,
  locale: string,
  days = 7
): readonly ChartDay[] {
  const byOffset = new Map(dailyTotals.map((d) => [d.dayOffset, d.listenedSeconds]))
  const todayIso = isoDate(new Date(nowMs))
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(fromMs + i * DAY_MS)
    return {
      label: d.toLocaleDateString(locale, { weekday: "narrow" }),
      listenedSeconds: byOffset.get(i) ?? 0,
      isToday: isoDate(d) === todayIso,
    }
  })
}

/** The tallest bar is 100%; a day with any listening keeps an 8% floor so it
 *  stays visible. */
export function barHeight(seconds: number, peakSeconds: number): string {
  if (seconds <= 0 || peakSeconds <= 0) return "0%"
  return `${Math.max(8, (seconds / peakSeconds) * 100)}%`
}

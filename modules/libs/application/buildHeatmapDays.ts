import type { DailyListeningTotal } from "@lib/domain/listeningSession.js"

export interface HeatmapDay {
  /** ISO date "YYYY-MM-DD" in local timezone. */
  readonly date: string
  /** Sum of seconds listened on this day. */
  readonly listenedSeconds: number
  /** True for the cell representing the current local-day. */
  readonly isToday: boolean
}

export interface BuildHeatmapDaysResult {
  readonly days: readonly HeatmapDay[]
  readonly columns: number
}

function startOfLocalDay(ms: number): Date {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** Returns the Monday on or before the given date. */
function mondayBefore(d: Date): Date {
  const result = new Date(d)
  const dow = result.getDay() // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = dow === 0 ? 6 : dow - 1
  result.setDate(result.getDate() - diff)
  return result
}

/**
 * Builds a fixed-size grid of HeatmapDay cells for the SVG heatmap.
 * The window is anchored to today's column and snaps to whole weeks
 * (every column is a complete Monday–Sunday).
 *
 * `daysBack` derives from the earliest entry in `totals`: until the user
 * has any history today's cell sits in the left-most column with empty
 * future cells stretching right. As history accumulates, today drifts
 * rightward — clamped at `totalDays - 7` so we always keep at least one
 * future-week buffer visible.
 *
 * `totalDays` is approximate — the snap-to-week may add up to 6 cells.
 */
export function buildHeatmapDays(
  totalDays: number,
  now: number,
  totals: readonly DailyListeningTotal[]
): BuildHeatmapDaysResult {
  const today = startOfLocalDay(now)
  const todayStr = toIsoDate(today)
  const MS_PER_DAY = 86_400_000

  // Earliest day with activity → that's how far back we render. Empty
  // history → daysBack = 0 → today is rendered in the left-most column.
  let daysBack = 0
  if (totals.length > 0) {
    const earliest = new Date(totals[0].date + "T00:00:00")
    daysBack = Math.max(0, Math.round((today.getTime() - earliest.getTime()) / MS_PER_DAY))
  }
  // Always keep at least a week of future cells visible on the right.
  daysBack = Math.min(daysBack, totalDays - 7)
  const daysForward = totalDays - daysBack

  const rawStart = new Date(today)
  rawStart.setDate(rawStart.getDate() - daysBack)
  const rawEnd = new Date(today)
  rawEnd.setDate(rawEnd.getDate() + daysForward)

  const gridStart = mondayBefore(rawStart)
  const gridEnd = new Date(rawEnd)
  const endDow = gridEnd.getDay()
  if (endDow !== 0) {
    gridEnd.setDate(gridEnd.getDate() + (7 - endDow))
  }

  const totalsByDate = new Map<string, number>()
  for (const t of totals) totalsByDate.set(t.date, t.listenedSeconds)

  const days: HeatmapDay[] = []
  const cursor = new Date(gridStart)
  while (cursor <= gridEnd) {
    const dateStr = toIsoDate(cursor)
    days.push({
      date: dateStr,
      listenedSeconds: totalsByDate.get(dateStr) ?? 0,
      isToday: dateStr === todayStr,
    })
    cursor.setDate(cursor.getDate() + 1)
  }

  const columns = Math.ceil(days.length / 7)
  return { days, columns }
}

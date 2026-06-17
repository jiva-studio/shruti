import { describe, expect, it } from "vitest"
import { buildHeatmapDays, type HeatmapDay } from "../buildHeatmapDays.js"

// Wednesday, 2026-04-15 12:00 local. Picked deliberately mid-week so the
// snap-to-Monday and snap-to-Sunday logic both have visible effects.
const NOW = new Date(2026, 3, 15, 12, 0, 0, 0).getTime()

function findByDate(days: readonly HeatmapDay[], date: string): HeatmapDay | undefined {
  return days.find((d) => d.date === date)
}

describe("buildHeatmapDays", () => {
  it("returns a grid that is a multiple of 7", () => {
    const { days } = buildHeatmapDays(224, NOW, [])
    expect(days.length % 7).toBe(0)
  })

  it("includes today's cell with isToday=true exactly once", () => {
    const { days } = buildHeatmapDays(224, NOW, [])
    const todayCells = days.filter((d) => d.isToday)
    expect(todayCells).toHaveLength(1)
    expect(todayCells[0].date).toBe("2026-04-15")
  })

  it("starts on a Monday and ends on a Sunday", () => {
    const { days } = buildHeatmapDays(224, NOW, [])
    const first = new Date(days[0].date + "T00:00:00")
    const last = new Date(days[days.length - 1].date + "T00:00:00")
    // 1 = Monday, 0 = Sunday in JS getDay()
    expect(first.getDay()).toBe(1)
    expect(last.getDay()).toBe(0)
  })

  it("populates listenedSeconds from totals matching by date", () => {
    const totals = [
      { date: "2026-04-14", listenedSeconds: 1800 },
      { date: "2026-04-15", listenedSeconds: 600 },
    ]
    const { days } = buildHeatmapDays(224, NOW, totals)
    expect(findByDate(days, "2026-04-14")?.listenedSeconds).toBe(1800)
    expect(findByDate(days, "2026-04-15")?.listenedSeconds).toBe(600)
    expect(findByDate(days, "2026-04-13")?.listenedSeconds).toBe(0)
  })

  it("returns columns equal to days.length / 7", () => {
    const { days, columns } = buildHeatmapDays(224, NOW, [])
    expect(columns).toBe(Math.ceil(days.length / 7))
  })

  it("ignores totals outside the rendered window without crashing", () => {
    const totals = [
      { date: "2020-01-01", listenedSeconds: 9999 },
      { date: "2030-01-01", listenedSeconds: 9999 },
    ]
    const { days } = buildHeatmapDays(224, NOW, totals)
    expect(days.every((d) => d.listenedSeconds === 0 || d.listenedSeconds < 9999)).toBe(true)
  })

  it("places today in the left-most column when there is no history", () => {
    const { days } = buildHeatmapDays(224, NOW, [])
    const todayIdx = days.findIndex((d) => d.isToday)
    expect(todayIdx).toBeGreaterThanOrEqual(0)
    // Column index = floor(idx / 7). With no history the today's cell
    // belongs to the first column.
    expect(Math.floor(todayIdx / 7)).toBe(0)
  })

  it("pushes today rightward as history accumulates", () => {
    const totals = [
      // 30 days ago
      { date: "2026-03-16", listenedSeconds: 60 },
    ]
    const { days } = buildHeatmapDays(224, NOW, totals)
    const todayIdx = days.findIndex((d) => d.isToday)
    // ~30 days back fits in roughly 4–5 weeks of history before today.
    const todayCol = Math.floor(todayIdx / 7)
    expect(todayCol).toBeGreaterThanOrEqual(4)
    expect(todayCol).toBeLessThanOrEqual(6)
  })

  it("picks the chronologically earliest date even when totals are unsorted", () => {
    const totals = [
      // Late entry first, earliest second — the port doesn't promise order.
      { date: "2026-04-10", listenedSeconds: 120 },
      { date: "2026-02-20", listenedSeconds: 60 },
      { date: "2026-03-05", listenedSeconds: 90 },
    ]
    const { days } = buildHeatmapDays(224, NOW, totals)
    const earliestEntry = findByDate(days, "2026-02-20")
    expect(earliestEntry?.listenedSeconds).toBe(60)
    // The whole history is renderable, including the unsorted earliest.
    const todayIdx = days.findIndex((d) => d.isToday)
    const earliestIdx = days.findIndex((d) => d.date === "2026-02-20")
    expect(earliestIdx).toBeGreaterThanOrEqual(0)
    expect(earliestIdx).toBeLessThan(todayIdx)
  })

  it("does not go negative when totalDays is under 7 (daysBack clamps at 0)", () => {
    // With totalDays < 7, `totalDays - 7` is negative; daysBack must clamp
    // to 0 so today still lands in the left-most column and the grid is sane.
    const totals = [{ date: "2026-04-01", listenedSeconds: 60 }]
    const { days, columns } = buildHeatmapDays(3, NOW, totals)
    expect(days.length % 7).toBe(0)
    expect(columns).toBeGreaterThanOrEqual(1)
    const todayIdx = days.findIndex((d) => d.isToday)
    expect(todayIdx).toBeGreaterThanOrEqual(0)
    expect(Math.floor(todayIdx / 7)).toBe(0)
  })

  it("computes daysBack via calendar units across a DST transition", () => {
    // EU spring-forward in 2026 is 2026-03-29. Earliest entry just before
    // it, today just after — millisecond subtraction would lose an hour
    // and could roll Math.round to the wrong integer near the boundary.
    const justAfterDst = new Date(2026, 2, 30, 12, 0, 0, 0).getTime() // Mon 2026-03-30
    const totals = [{ date: "2026-03-28", listenedSeconds: 60 }] // Sat before DST
    const { days } = buildHeatmapDays(224, justAfterDst, totals)
    const todayCell = days.find((d) => d.isToday)
    expect(todayCell?.date).toBe("2026-03-30")
    const earliest = findByDate(days, "2026-03-28")
    expect(earliest?.listenedSeconds).toBe(60)
  })
})

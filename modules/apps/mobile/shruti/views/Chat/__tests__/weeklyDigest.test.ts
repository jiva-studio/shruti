import { describe, expect, it } from "vitest"
import { barHeight, buildChartDays } from "../weeklyDigest.js"

const DAY = 86_400_000
const FROM = new Date(2026, 0, 1).getTime()

describe("buildChartDays", () => {
  it("always returns seven columns", () => {
    expect(buildChartDays([], FROM, FROM, "en")).toHaveLength(7)
  })

  it("fills a day with no listening with zero", () => {
    const days = buildChartDays([{ dayOffset: 2, listenedSeconds: 600 }], FROM, FROM, "en")
    expect(days.map((d) => d.listenedSeconds)).toEqual([0, 0, 600, 0, 0, 0, 0])
  })

  it("marks the column that is today", () => {
    const now = FROM + 3 * DAY
    expect(buildChartDays([], FROM, now, "en").map((d) => d.isToday)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ])
  })

  it("marks no column when today is outside the window", () => {
    const now = FROM + 30 * DAY
    expect(buildChartDays([], FROM, now, "en").some((d) => d.isToday)).toBe(false)
  })
})

describe("barHeight", () => {
  it("is flat for a day with nothing on it", () => {
    expect(barHeight(0, 600)).toBe("0%")
  })

  it("is flat when nothing was listened to all week", () => {
    expect(barHeight(0, 0)).toBe("0%")
  })

  it("gives the peak the full height", () => {
    expect(barHeight(600, 600)).toBe("100%")
  })

  it("keeps a floor so a small day stays visible", () => {
    expect(barHeight(1, 10_000)).toBe("8%")
  })
})

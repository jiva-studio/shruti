import { describe, expect, it } from "vitest"
import { collectDailyCandidates, NOTIFICATION_PRIORITY } from "../notificationPlanner.js"

const DAY_MS = 86_400_000

function collect(over: Partial<Parameters<typeof collectDailyCandidates>[0]> = {}) {
  return collectDailyCandidates({
    enabled: true,
    time: "08:30",
    title: "Time to listen",
    body: "A lecture is waiting",
    nowMs: new Date(2026, 5, 1, 7, 0, 0, 0).getTime(),
    horizonDays: 3,
    ...over,
  })
}

describe("collectDailyCandidates", () => {
  it("offers one reminder per day at the chosen local time", () => {
    const out = collect()
    expect(out).toHaveLength(3)
    for (const [i, c] of out.entries()) {
      const at = new Date(c.fireAtMs)
      expect(at.getHours()).toBe(8)
      expect(at.getMinutes()).toBe(30)
      expect(at.getDate()).toBe(1 + i)
      expect(c.priority).toBe(NOTIFICATION_PRIORITY.daily)
      expect(c.title).toBe("Time to listen")
      expect(c.body).toBe("A lecture is waiting")
    }
  })

  it("skips today once its time has gone by, and keeps it while it has not", () => {
    const before = collect({ nowMs: new Date(2026, 5, 1, 8, 29, 0, 0).getTime() })
    expect(new Date(before[0].fireAtMs).getDate()).toBe(1)
    expect(before).toHaveLength(3)

    const after = collect({ nowMs: new Date(2026, 5, 1, 8, 31, 0, 0).getTime() })
    expect(new Date(after[0].fireAtMs).getDate()).toBe(2)
    expect(after).toHaveLength(2)
  })

  it("offers nothing while the reminder is switched off", () => {
    expect(collect({ enabled: false })).toEqual([])
  })

  it("offers nothing for a time it cannot read", () => {
    expect(collect({ time: "" })).toEqual([])
    expect(collect({ time: "morning" })).toEqual([])
    expect(collect({ time: "8" })).toEqual([])
    expect(collect({ time: "24:00" })).toEqual([])
    expect(collect({ time: "08:60" })).toEqual([])
  })

  it("accepts midnight and the last minute of the day", () => {
    const midnight = collect({ time: "00:00", nowMs: new Date(2026, 5, 1, 7, 0).getTime() })
    expect(new Date(midnight[0].fireAtMs).getHours()).toBe(0)
    expect(new Date(midnight[0].fireAtMs).getDate()).toBe(2)

    const lastMinute = collect({ time: "23:59" })
    expect(new Date(lastMinute[0].fireAtMs).getHours()).toBe(23)
    expect(new Date(lastMinute[0].fireAtMs).getDate()).toBe(1)
  })

  it("gives every day its own stable id so the rolling window re-arms in place", () => {
    const first = collect()
    const again = collect({ nowMs: new Date(2026, 5, 1, 7, 30, 0, 0).getTime() })
    expect(new Set(first.map((c) => c.id)).size).toBe(first.length)
    expect(again.map((c) => c.id)).toEqual(first.map((c) => c.id))
  })

  it("crosses a month boundary rather than repeating the last day", () => {
    const out = collect({ nowMs: new Date(2026, 5, 29, 7, 0, 0, 0).getTime(), horizonDays: 4 })
    expect(out.map((c) => new Date(c.fireAtMs).getDate())).toEqual([29, 30, 1, 2])
  })

  it("offers nothing for an empty horizon", () => {
    expect(collect({ horizonDays: 0 })).toEqual([])
  })

  it("keeps a reminder that is due within the next day ahead of now", () => {
    const nowMs = new Date(2026, 5, 1, 7, 0, 0, 0).getTime()
    const out = collect({ nowMs })
    expect(out.every((c) => c.fireAtMs > nowMs)).toBe(true)
    expect(out[out.length - 1].fireAtMs).toBeLessThan(nowMs + 3 * DAY_MS)
  })
})

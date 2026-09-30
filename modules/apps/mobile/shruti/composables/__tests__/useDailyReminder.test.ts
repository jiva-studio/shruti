import { describe, expect, it, vi } from "vitest"
import { reportError } from "@shruti/services/monitoring/reportError.js"
import { applyDailyReminder, nextOccurrence } from "../useDailyReminder.js"
import { on as onProactive } from "@shruti/services/proactiveEvents.js"
import type { INotificationScheduler } from "@ports/app/notifications.js"

vi.mock("@shruti/services/monitoring/reportError.js", () => ({ reportError: vi.fn() }))

function makeNotifications(
  overrides: Partial<INotificationScheduler> = {}
): INotificationScheduler & {
  cancel: ReturnType<typeof vi.fn>
  requestPermission: ReturnType<typeof vi.fn>
  schedule: ReturnType<typeof vi.fn>
} {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    requestPermission: vi.fn().mockResolvedValue("granted"),
    schedule: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as INotificationScheduler & {
    cancel: ReturnType<typeof vi.fn>
    requestPermission: ReturnType<typeof vi.fn>
    schedule: ReturnType<typeof vi.fn>
  }
}

describe("nextOccurrence", () => {
  it("schedules later today when the target time is still ahead", () => {
    const now = new Date("2026-05-16T08:00:00")
    const at = nextOccurrence("09:00", now)
    expect(at).toBe(new Date("2026-05-16T09:00:00").getTime())
  })

  it("rolls over to tomorrow when the target time has already passed today", () => {
    const now = new Date("2026-05-16T10:30:00")
    const at = nextOccurrence("09:00", now)
    expect(at).toBe(new Date("2026-05-17T09:00:00").getTime())
  })

  it("returns null for malformed time strings", () => {
    expect(nextOccurrence("", new Date())).toBeNull()
    expect(nextOccurrence("not-a-time", new Date())).toBeNull()
    expect(nextOccurrence("25:00", new Date())).toBeNull()
    expect(nextOccurrence("12:60", new Date())).toBeNull()
  })

  it("rolls over correctly across a DST-style local clock jump", () => {
    const now = new Date("2026-03-29T03:30:00")
    const at = nextOccurrence("09:00", now)
    expect(at).toBe(new Date("2026-03-29T09:00:00").getTime())
  })
})

describe("applyDailyReminder", () => {
  it("never schedules — the planner now owns the daily reminder", async () => {
    const notifications = makeNotifications()
    await applyDailyReminder(
      { enabled: true, time: "09:00", title: "T", body: "B" },
      { notifications }
    )
    expect(notifications.schedule).not.toHaveBeenCalled()
    expect(notifications.requestPermission).not.toHaveBeenCalled()
  })

  it("cancels the legacy recurring alarm (id 9001) as a migration step", async () => {
    const notifications = makeNotifications()
    await applyDailyReminder(
      { enabled: false, time: "09:00", title: "T", body: "B" },
      { notifications }
    )
    expect(notifications.cancel).toHaveBeenCalledWith(9001)
  })

  it("reports a legacy alarm it cannot cancel and still asks for a replan", async () => {
    const boom = new Error("scheduler unavailable")
    const notifications = makeNotifications()
    notifications.cancel.mockRejectedValueOnce(boom)
    const replan = vi.fn()
    const off = onProactive("replan", replan)
    try {
      await applyDailyReminder(
        { enabled: false, time: "09:00", title: "T", body: "B" },
        { notifications }
      )
    } finally {
      off()
    }
    expect(reportError).toHaveBeenCalledWith("notifications", boom)
    expect(replan).toHaveBeenCalledOnce()
  })

  it("emits `replan` so the scheduler re-runs the planner promptly", async () => {
    const notifications = makeNotifications()
    const replan = vi.fn()
    const off = onProactive("replan", replan)
    try {
      await applyDailyReminder(
        { enabled: true, time: "09:00", title: "T", body: "B" },
        { notifications }
      )
    } finally {
      off()
    }
    expect(replan).toHaveBeenCalledTimes(1)
  })
})

import { describe, expect, it, vi } from "vitest"
import { applyDailyReminder, nextOccurrence } from "../useDailyReminder.js"
import type { INotificationScheduler } from "@ports/app/notifications.js"

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
    // Even if local time jumps an hour forward, the next occurrence
    // formula reads "the next moment local-time hour:minute matches" —
    // computing from a `now` that's just after the jump still produces
    // a target later today (not tomorrow).
    const now = new Date("2026-03-29T03:30:00")
    const at = nextOccurrence("09:00", now)
    expect(at).toBe(new Date("2026-03-29T09:00:00").getTime())
  })
})

describe("applyDailyReminder", () => {
  it("always cancels the previous reminder before scheduling — prevents stragglers", async () => {
    const notifications = makeNotifications()
    await applyDailyReminder(
      { enabled: true, time: "09:00", title: "T", body: "B" },
      { notifications }
    )
    expect(notifications.cancel).toHaveBeenCalledTimes(1)
    expect(notifications.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      notifications.schedule.mock.invocationCallOrder[0]
    )
  })

  it("does not call schedule when reminder is disabled", async () => {
    const notifications = makeNotifications()
    await applyDailyReminder(
      { enabled: false, time: "09:00", title: "T", body: "B" },
      { notifications }
    )
    expect(notifications.cancel).toHaveBeenCalledTimes(1)
    expect(notifications.requestPermission).not.toHaveBeenCalled()
    expect(notifications.schedule).not.toHaveBeenCalled()
  })

  it("aborts (no schedule) when the user denies notification permission", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const notifications = makeNotifications({
      requestPermission: vi.fn().mockResolvedValue("denied"),
    })
    await applyDailyReminder(
      { enabled: true, time: "09:00", title: "T", body: "B" },
      { notifications }
    )
    expect(notifications.schedule).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("passes the caller-localized title and body straight through to the scheduler", async () => {
    const notifications = makeNotifications()
    await applyDailyReminder(
      { enabled: true, time: "09:00", title: "Shruti", body: "Время слушать садху!" },
      { notifications }
    )
    expect(notifications.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Shruti",
        body: "Время слушать садху!",
        every: "day",
      })
    )
  })

  it("does not schedule when the time string is malformed", async () => {
    const notifications = makeNotifications()
    await applyDailyReminder(
      { enabled: true, time: "bogus", title: "T", body: "B" },
      { notifications }
    )
    expect(notifications.schedule).not.toHaveBeenCalled()
    // Cancel still runs so that an existing reminder is cleared.
    expect(notifications.cancel).toHaveBeenCalled()
  })
})

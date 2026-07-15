import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  arbitrate,
  reconcile,
  NOTIFICATION_PRIORITY,
  type NotificationCandidate,
} from "../notificationPlanner.js"
import {
  NotificationsDisabledError,
  type INotificationScheduler,
} from "@ports/app/notifications.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"

vi.mock("@shruti/services/monitoring/reportError.js", () => ({
  reportError: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(reportError).mockClear()
})

const DAY_MS = 86_400_000
// A fixed local-noon anchor so each "+N days" offset lands on a distinct
// local calendar day regardless of the test machine's timezone.
const NOON = new Date(2026, 5, 1, 12, 0, 0, 0).getTime()

function candidate(over: Partial<NotificationCandidate>): NotificationCandidate {
  return {
    id: 1,
    fireAtMs: NOON + DAY_MS,
    priority: NOTIFICATION_PRIORITY.daily,
    kind: "daily",
    title: "t",
    body: "b",
    ...over,
  }
}

describe("arbitrate", () => {
  it("drops the daily push when a higher-priority push lands the same day", () => {
    const fireAtMs = NOON + DAY_MS
    const daily = candidate({
      id: 1,
      fireAtMs,
      priority: NOTIFICATION_PRIORITY.daily,
      kind: "daily",
    })
    const inactivity = candidate({
      id: 2,
      fireAtMs: fireAtMs + 3_600_000,
      priority: NOTIFICATION_PRIORITY.inactivity,
      kind: "inactivity",
    })
    const winners = arbitrate([daily, inactivity], NOON)
    expect(winners).toHaveLength(1)
    expect(winners[0].kind).toBe("inactivity")
  })

  it("keeps one push per day when candidates fall on different days", () => {
    const day1 = candidate({ id: 1, fireAtMs: NOON + DAY_MS })
    const day2 = candidate({ id: 2, fireAtMs: NOON + 2 * DAY_MS })
    const winners = arbitrate([day1, day2], NOON)
    expect(winners.map((w) => w.id)).toEqual([1, 2])
  })

  it("drops candidates whose fire time is in the past", () => {
    const past = candidate({ id: 1, fireAtMs: NOON - DAY_MS })
    const future = candidate({ id: 2, fireAtMs: NOON + DAY_MS })
    const winners = arbitrate([past, future], NOON)
    expect(winners.map((w) => w.id)).toEqual([2])
  })

  it("tie-breaks same-day by priority, then by earliest fireAtMs", () => {
    const fireAtMs = NOON + DAY_MS
    // Same priority, different times → earlier wins.
    const later = candidate({ id: 1, fireAtMs: fireAtMs + 7_200_000, priority: 20, kind: "a" })
    const earlier = candidate({ id: 2, fireAtMs: fireAtMs + 3_600_000, priority: 20, kind: "b" })
    // Higher priority beats both regardless of time.
    const top = candidate({ id: 3, fireAtMs: fireAtMs + 9_000_000, priority: 40, kind: "c" })
    const winners = arbitrate([later, earlier, top], NOON)
    expect(winners).toHaveLength(1)
    expect(winners[0].id).toBe(3)

    const twoWay = arbitrate([later, earlier], NOON)
    expect(twoWay).toHaveLength(1)
    expect(twoWay[0].id).toBe(2) // earlier fireAtMs wins the tie
  })

  it("holiday beats inactivity on the same day", () => {
    const fireAtMs = NOON + DAY_MS
    const inactivity = candidate({
      id: 1,
      fireAtMs,
      priority: NOTIFICATION_PRIORITY.inactivity,
      kind: "inactivity",
    })
    const holiday = candidate({
      id: 2,
      fireAtMs: fireAtMs + 3_600_000,
      priority: NOTIFICATION_PRIORITY.holiday,
      kind: "holiday",
    })
    const winners = arbitrate([inactivity, holiday], NOON)
    expect(winners).toHaveLength(1)
    expect(winners[0].kind).toBe("holiday")
  })

  it("returns winners sorted by fireAtMs", () => {
    const a = candidate({ id: 1, fireAtMs: NOON + 3 * DAY_MS })
    const b = candidate({ id: 2, fireAtMs: NOON + DAY_MS })
    const c = candidate({ id: 3, fireAtMs: NOON + 2 * DAY_MS })
    const winners = arbitrate([a, b, c], NOON)
    expect(winners.map((w) => w.id)).toEqual([2, 3, 1])
  })
})

function fakeNotifications(): INotificationScheduler & {
  schedule: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
} {
  return {
    checkPermission: vi.fn().mockResolvedValue("granted"),
    requestPermission: vi.fn().mockResolvedValue("granted"),
    schedule: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    cancelAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as INotificationScheduler & {
    schedule: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }
}

describe("reconcile", () => {
  it("schedules new candidates and records them in `managed`", async () => {
    const notifications = fakeNotifications()
    const managed = new Map<number, string>()
    const desired = [candidate({ id: 7, fireAtMs: NOON + DAY_MS, title: "x", body: "y" })]
    await reconcile(desired, notifications, managed)
    expect(notifications.schedule).toHaveBeenCalledTimes(1)
    expect(notifications.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, title: "x", body: "y", at: NOON + DAY_MS })
    )
    expect(managed.has(7)).toBe(true)

    // Re-running with the identical desired set is idempotent — no re-arm.
    await reconcile(desired, notifications, managed)
    expect(notifications.schedule).toHaveBeenCalledTimes(1)
  })

  it("cancels managed ids that dropped out of the desired set", async () => {
    const notifications = fakeNotifications()
    const managed = new Map<number, string>()
    await reconcile(
      [candidate({ id: 7 }), candidate({ id: 8, fireAtMs: NOON + 2 * DAY_MS })],
      notifications,
      managed
    )
    expect(managed.size).toBe(2)

    // Drop id 8 from the desired set → it must be cancelled and forgotten.
    await reconcile([candidate({ id: 7 })], notifications, managed)
    expect(notifications.cancel).toHaveBeenCalledWith(8)
    expect(managed.has(8)).toBe(false)
    expect(managed.has(7)).toBe(true)
  })

  it("stays silent when notifications are disabled, and retries once granted", async () => {
    const notifications = fakeNotifications()
    // Permission off: the adapter surfaces a typed NotificationsDisabledError.
    notifications.schedule.mockRejectedValueOnce(new NotificationsDisabledError())
    const managed = new Map<number, string>()
    const desired = [candidate({ id: 7, fireAtMs: NOON + DAY_MS })]

    await reconcile(desired, notifications, managed)
    // Not a fault → not reported, and NOT recorded so it can retry.
    expect(reportError).not.toHaveBeenCalled()
    expect(managed.has(7)).toBe(false)

    // Permission granted later → schedule succeeds and is now recorded.
    await reconcile(desired, notifications, managed)
    expect(managed.has(7)).toBe(true)
    expect(reportError).not.toHaveBeenCalled()
  })

  it("reports a genuine schedule failure", async () => {
    const notifications = fakeNotifications()
    notifications.schedule.mockRejectedValueOnce(new Error("scheduler exploded"))
    const managed = new Map<number, string>()

    await reconcile([candidate({ id: 7, fireAtMs: NOON + DAY_MS })], notifications, managed)
    expect(reportError).toHaveBeenCalledWith("notify-planner", expect.any(Error))
    expect(managed.has(7)).toBe(false)
  })
})

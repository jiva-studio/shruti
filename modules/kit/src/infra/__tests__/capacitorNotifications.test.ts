import { beforeEach, describe, expect, it, vi } from "vitest"

const schedule = vi.fn()
const cancel = vi.fn()
const getPending = vi.fn()
const checkPermissions = vi.fn()
const requestPermissions = vi.fn()

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: { schedule, cancel, getPending, checkPermissions, requestPermissions },
}))

const { useCapacitorNotificationScheduler } =
  await import("../notifications/capacitorNotifications.js")

describe("useCapacitorNotificationScheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("maps permission states to the port dialect", async () => {
    const s = useCapacitorNotificationScheduler()
    checkPermissions.mockResolvedValue({ display: "granted" })
    expect(await s.checkPermission()).toBe("granted")
    checkPermissions.mockResolvedValue({ display: "denied" })
    expect(await s.checkPermission()).toBe("denied")
    checkPermissions.mockResolvedValue({ display: "prompt" })
    expect(await s.checkPermission()).toBe("unknown")
    requestPermissions.mockResolvedValue({ display: "default" })
    expect(await s.requestPermission()).toBe("unknown")
  })

  it("schedules a daily notification as a recurring hour/minute alarm", async () => {
    const s = useCapacitorNotificationScheduler()
    const at = new Date(2026, 5, 6, 9, 30).getTime()
    await s.schedule({ id: 1, title: "T", body: "B", at, every: "day" })
    const arg = schedule.mock.calls[0][0].notifications[0]
    expect(arg.schedule.on).toEqual({ hour: 9, minute: 30 })
    expect(arg.schedule.allowWhileIdle).toBe(true)
    expect(arg.schedule.at).toBeUndefined()
  })

  it("schedules a one-shot notification at an absolute time", async () => {
    const s = useCapacitorNotificationScheduler()
    const at = new Date(2026, 5, 6, 9, 30).getTime()
    await s.schedule({ id: 2, title: "T", body: "B", at, extra: { k: 1 } })
    const arg = schedule.mock.calls[0][0].notifications[0]
    expect(arg.schedule.at).toBeInstanceOf(Date)
    expect(arg.schedule.at.getTime()).toBe(at)
    expect(arg.schedule.on).toBeUndefined()
    expect(arg.extra).toEqual({ k: 1 })
  })

  it("cancelAll skips the cancel call when nothing is pending", async () => {
    const s = useCapacitorNotificationScheduler()
    getPending.mockResolvedValue({ notifications: [] })
    await s.cancelAll()
    expect(cancel).not.toHaveBeenCalled()
  })

  it("cancelAll cancels every pending notification", async () => {
    const s = useCapacitorNotificationScheduler()
    getPending.mockResolvedValue({ notifications: [{ id: 1 }, { id: 2 }] })
    await s.cancelAll()
    expect(cancel).toHaveBeenCalledWith({ notifications: [{ id: 1 }, { id: 2 }] })
  })
})

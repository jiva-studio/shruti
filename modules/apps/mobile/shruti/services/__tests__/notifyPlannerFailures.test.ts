import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationsDisabledError } from "@ports/app/notifications.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"
import { reportNotifyPlannerFailure } from "../notifyPlannerFailures.js"

vi.mock("@shruti/services/monitoring/reportError.js", () => ({
  reportError: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(reportError).mockClear()
})

describe("reportNotifyPlannerFailure", () => {
  it("stays silent when a push is refused because notifications are disabled", () => {
    reportNotifyPlannerFailure(new NotificationsDisabledError(), "schedule")
    expect(reportError).not.toHaveBeenCalled()
  })

  it("reports a genuine schedule failure", () => {
    const err = new Error("scheduler exploded")
    reportNotifyPlannerFailure(err, "schedule")
    expect(reportError).toHaveBeenCalledWith("notify-planner", err)
  })

  it("reports every failed cancel", () => {
    const err = new NotificationsDisabledError()
    reportNotifyPlannerFailure(err, "cancel")
    expect(reportError).toHaveBeenCalledWith("notify-planner", err)
  })
})

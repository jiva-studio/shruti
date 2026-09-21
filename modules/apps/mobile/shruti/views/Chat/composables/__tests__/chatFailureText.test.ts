import { describe, expect, it } from "vitest"
import { failedTextKey, resetWhenPhrase, retryWhenPhrase } from "../chatFailureText.js"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe("failedTextKey", () => {
  it("maps a known code to its own string", () => {
    expect(failedTextKey("network")).toBe("chat.errNetwork")
  })

  it("treats every 5xx as a service-not-ready", () => {
    expect(failedTextKey("http_503")).toBe("chat.errServiceNotReady")
  })

  it("falls back for a code it does not know", () => {
    expect(failedTextKey("something_new")).toBe("chat.errUnknown")
  })
})

describe("retryWhenPhrase", () => {
  it("counts seconds under a minute", () => {
    expect(retryWhenPhrase(30_000, 0, 0)).toEqual({
      key: "chat.retryInSeconds",
      params: { n: 30 },
    })
  })

  it("rounds up to whole minutes under an hour", () => {
    expect(retryWhenPhrase(90_000, 0, 0)).toEqual({
      key: "chat.retryInMinutes",
      params: { n: 2 },
    })
  })

  it("names a wall-clock time past an hour", () => {
    const now = new Date(2026, 0, 1, 9, 0).getTime()
    const deadline = new Date(2026, 0, 1, 12, 30).getTime()
    expect(retryWhenPhrase(deadline - now, deadline, now)).toEqual({
      key: "chat.retryAtTime",
      params: { time: "12:30" },
    })
  })

  it("says tomorrow once the local day has turned", () => {
    const now = new Date(2026, 0, 1, 22, 0).getTime()
    const deadline = new Date(2026, 0, 2, 3, 5).getTime()
    expect(retryWhenPhrase(deadline - now, deadline, now)).toEqual({
      key: "chat.retryAtTimeTomorrow",
      params: { time: "03:05" },
    })
  })
})

describe("resetWhenPhrase", () => {
  it("has nothing to say without a deadline", () => {
    expect(resetWhenPhrase(undefined, 0)).toBeNull()
  })

  it("reads as now once the window has rolled over", () => {
    expect(resetWhenPhrase(0, HOUR)).toEqual({ key: "chat.retryNow" })
  })

  it("counts down while the window is still open", () => {
    expect(resetWhenPhrase(30_000, 0)).toEqual({
      key: "chat.retryInSeconds",
      params: { n: 30 },
    })
  })
})

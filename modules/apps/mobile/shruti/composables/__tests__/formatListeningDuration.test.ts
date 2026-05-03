import { describe, expect, it } from "vitest"
import { formatListeningDuration } from "../formatListeningDuration.js"

// Stub translator that mirrors the real vue-i18n shape: returns
// "key:{paramKey=value,...}" so each branch's exact key + interpolation
// payload is observable in the assertion.
const t = (key: string, named?: Record<string, number | string>): string => {
  if (!named) return `${key}:{}`
  const parts = Object.entries(named)
    .map(([k, v]) => `${k}=${v}`)
    .join(",")
  return `${key}:{${parts}}`
}

describe("formatListeningDuration", () => {
  it("formats sub-hour totals as minutes", () => {
    expect(formatListeningDuration(0, t)).toBe("app.duration.minutes:{n=0}")
    expect(formatListeningDuration(30, t)).toBe("app.duration.minutes:{n=0}")
    expect(formatListeningDuration(60, t)).toBe("app.duration.minutes:{n=1}")
    expect(formatListeningDuration(59 * 60 + 59, t)).toBe("app.duration.minutes:{n=59}")
  })

  it("formats whole-hour totals without minutes", () => {
    expect(formatListeningDuration(60 * 60, t)).toBe("app.duration.hours:{n=1}")
  })

  it("formats sub-day totals as hours and minutes", () => {
    expect(formatListeningDuration(2 * 3600 + 15 * 60, t)).toBe(
      "app.duration.hoursAndMinutes:{h=2,m=15}"
    )
  })

  it("formats whole-day totals without hours", () => {
    expect(formatListeningDuration(86_400, t)).toBe("app.duration.days:{n=1}")
  })

  it("formats multi-day totals as days and hours, dropping minutes", () => {
    expect(formatListeningDuration(86_400 + 3 * 3600 + 30 * 60, t)).toBe(
      "app.duration.daysAndHours:{d=1,h=3}"
    )
  })

  it("clamps negative input to zero", () => {
    expect(formatListeningDuration(-500, t)).toBe("app.duration.minutes:{n=0}")
  })

  it("floors fractional seconds before bucketing", () => {
    expect(formatListeningDuration(59.9, t)).toBe("app.duration.minutes:{n=0}")
    expect(formatListeningDuration(3600.5, t)).toBe("app.duration.hours:{n=1}")
  })
})

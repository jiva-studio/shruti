import { beforeEach, describe, expect, it, vi } from "vitest"

interface CapturedException {
  readonly error: unknown
  readonly options: {
    level?: string
    tags?: Record<string, string>
    extra?: Record<string, unknown>
  }
}

const captured: CapturedException[] = []

vi.mock("@sentry/capacitor", () => ({
  captureException: (error: unknown, options: CapturedException["options"]) => {
    captured.push({ error, options })
  },
}))

import { logSnapshot, clearLogs } from "@lectorium/services/logger/index.js"
import { reportError, reportWarning } from "../reportError.js"

class NetworkError extends Error {
  override readonly name = "NetworkError"
}

describe("reportError", () => {
  beforeEach(() => {
    captured.length = 0
    clearLogs()
  })

  it("reports a genuine failure tagged with its scope", () => {
    reportError("downloads", new Error("disk full"))

    expect(captured).toHaveLength(1)
    expect(captured[0].options.tags).toEqual({ scope: "downloads" })
    expect(captured[0].options.level).toBeUndefined()
  })

  it("attaches context only when given", () => {
    reportError("downloads", new Error("disk full"), { trackId: "t-1" })
    reportError("downloads", new Error("disk full"))

    expect(captured[0].options.extra).toEqual({ trackId: "t-1" })
    expect("extra" in captured[1].options).toBe(false)
  })

  it("drops a benign failure instead of raising an issue", () => {
    reportError("filesystem", new Error("Directory already exists"))
    reportError("http", new NetworkError("servers are unreachable"))

    expect(captured).toEqual([])
  })

  it("keeps every failure in the debug buffer, benign ones included", () => {
    reportError("filesystem", new Error("Directory already exists"))
    reportError("downloads", new Error("disk full"))

    const messages = logSnapshot().map((e) => e.text)
    expect(messages.filter((m) => m.includes("[filesystem]"))).toHaveLength(1)
    expect(messages.filter((m) => m.includes("[downloads]"))).toHaveLength(1)
  })

  it("stays visible for a failed dynamic import, despite the network wording", () => {
    reportError("router", new TypeError("Failed to fetch dynamically imported module: /x.js"))

    expect(captured).toHaveLength(1)
  })
})

describe("reportWarning", () => {
  beforeEach(() => {
    captured.length = 0
    clearLogs()
  })

  it("reports at warning level so it trends without paging", () => {
    reportWarning("purchases", new Error("empty offerings"), { at: "init" })

    expect(captured).toHaveLength(1)
    expect(captured[0].options.level).toBe("warning")
    expect(captured[0].options.tags).toEqual({ scope: "purchases" })
    expect(captured[0].options.extra).toEqual({ at: "init" })
  })

  it("drops a benign condition the same way reportError does", () => {
    reportWarning("purchases", new NetworkError("network unreachable"))

    expect(captured).toEqual([])
    expect(
      logSnapshot()
        .map((e) => e.text)
        .join()
    ).toContain("[purchases]")
  })
})

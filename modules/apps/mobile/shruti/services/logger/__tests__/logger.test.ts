import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  LOG_CAPACITY,
  clearLogs,
  installConsoleCapture,
  logCount,
  logSnapshot,
  recordError,
  subscribeLogs,
} from "../index.js"

beforeEach(() => clearLogs())

describe("the buffer", () => {
  it("keeps the text and level of a recorded error", () => {
    recordError("[purchases]", "boom")
    expect(logSnapshot()).toHaveLength(1)
    expect(logSnapshot()[0]).toMatchObject({ level: "error", text: "[purchases] boom" })
  })

  it("gives every entry an id that increases with insertion order", () => {
    recordError("a")
    recordError("b")
    const [first, second] = logSnapshot()
    expect(second.id).toBeGreaterThan(first.id)
  })

  it("stamps the entry with the wall clock", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"))
    recordError("x")
    expect(logSnapshot()[0].ts).toBe(Date.parse("2026-01-02T03:04:05Z"))
    vi.useRealTimers()
  })

  it("drops the oldest lines once it is full", () => {
    for (let i = 0; i < LOG_CAPACITY + 10; i++) recordError(`line-${i}`)
    expect(logCount()).toBe(LOG_CAPACITY)
    expect(logSnapshot()[0].text).toBe("line-10")
    expect(logSnapshot()[LOG_CAPACITY - 1].text).toBe(`line-${LOG_CAPACITY + 9}`)
  })

  it("empties on clear", () => {
    recordError("x")
    clearLogs()
    expect(logCount()).toBe(0)
  })
})

describe("formatting", () => {
  it("keeps a string as written", () => {
    recordError("plain")
    expect(logSnapshot()[0].text).toBe("plain")
  })

  it("prefers an Error's stack, falling back to name and message", () => {
    const err = new Error("kaput")
    recordError(err)
    expect(logSnapshot()[0].text).toBe(err.stack)

    clearLogs()
    const bare = new Error("no stack")
    bare.stack = undefined
    recordError(bare)
    expect(logSnapshot()[0].text).toBe("Error: no stack")
  })

  it("spells out undefined rather than dropping the argument", () => {
    recordError("a", undefined, "b")
    expect(logSnapshot()[0].text).toBe("a undefined b")
  })

  it("serialises a plain object", () => {
    recordError({ a: 1 })
    expect(logSnapshot()[0].text).toBe('{"a":1}')
  })

  it("survives a circular object", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    recordError(circular)
    expect(logSnapshot()[0].text).toBe("[object Object]")
  })
})

describe("subscribers", () => {
  it("are notified on append and on clear", () => {
    const seen = vi.fn()
    const off = subscribeLogs(seen)
    recordError("x")
    clearLogs()
    expect(seen).toHaveBeenCalledTimes(2)
    off()
  })

  it("stop hearing after unsubscribing", () => {
    const seen = vi.fn()
    subscribeLogs(seen)()
    recordError("x")
    expect(seen).not.toHaveBeenCalled()
  })

  it("a throwing subscriber does not stop logging or the other subscribers", () => {
    const good = vi.fn()
    const offBad = subscribeLogs(() => {
      throw new Error("flaky")
    })
    const offGood = subscribeLogs(good)
    expect(() => recordError("x")).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    expect(logCount()).toBe(1)
    offBad()
    offGood()
  })
})

describe("console capture", () => {
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  afterEach(() => Object.assign(console, originals))

  // One test, because the install guard is process-wide: restoring console.*
  // after the first install leaves a second call a no-op for good.
  it("records every console method at its own level, still delegates, and installs once", () => {
    const delegated: string[] = []
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      console[m] = ((...a: unknown[]) => delegated.push(`${m}:${String(a[0])}`)) as never
    }
    installConsoleCapture()
    installConsoleCapture()
    clearLogs()

    console.log("l")
    console.info("i")
    console.warn("w")
    console.error("e")
    console.debug("d")

    expect(logSnapshot().map((x) => [x.level, x.text])).toEqual([
      ["info", "l"],
      ["info", "i"],
      ["warn", "w"],
      ["error", "e"],
      ["debug", "d"],
    ])
    expect(delegated).toEqual(["log:l", "info:i", "warn:w", "error:e", "debug:d"])
  })
})

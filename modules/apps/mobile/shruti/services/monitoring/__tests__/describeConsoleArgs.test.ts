import { describe, it, expect } from "vitest"
import { ONLY_OBJECT_TAGS, describeConsoleArgs } from "../describeConsoleArgs.js"

describe("ONLY_OBJECT_TAGS", () => {
  it("matches titles made of only [object X] tokens", () => {
    expect(ONLY_OBJECT_TAGS.test("[object Object]")).toBe(true)
    expect(ONLY_OBJECT_TAGS.test("[object Object] [object Error]")).toBe(true)
  })
  it("leaves real messages alone", () => {
    expect(ONLY_OBJECT_TAGS.test("[auth] restore failed: boom")).toBe(false)
    expect(ONLY_OBJECT_TAGS.test("TypeError: Failed to fetch")).toBe(false)
  })
})

describe("describeConsoleArgs", () => {
  it("returns null when there is nothing usable", () => {
    expect(describeConsoleArgs(undefined)).toBeNull()
    expect(describeConsoleArgs([])).toBeNull()
  })

  it("surfaces the message of an error-like object", () => {
    expect(describeConsoleArgs([{ message: "disk full" }])).toBe("disk full")
  })

  it("prefixes a code/status when present", () => {
    expect(describeConsoleArgs([{ code: "E_NET", message: "offline" }])).toBe("E_NET: offline")
    expect(describeConsoleArgs([{ status: 500, message: "boom" }])).toBe("500: boom")
  })

  it("serialises a plain object instead of [object Object]", () => {
    expect(describeConsoleArgs([{ a: 1, b: "x" }])).toBe('{"a":1,"b":"x"}')
  })

  it("falls back to the key list for an unserialisable (circular) object", () => {
    const circular: Record<string, unknown> = { foo: 1 }
    circular["self"] = circular
    expect(describeConsoleArgs([circular])).toBe("{ foo, self }")
  })

  it("joins a string prefix with a described object", () => {
    expect(describeConsoleArgs(["context:", { message: "bad" }])).toBe("context: bad")
  })

  it("renders a real Error as name: message", () => {
    expect(describeConsoleArgs([new TypeError("nope")])).toBe("TypeError: nope")
  })
})

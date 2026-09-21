import { describe, expect, it, vi } from "vitest"
import { findEventBoundary, parseSseBlock } from "../sseParser.js"

function block(event: string | null, data: unknown): string {
  const body = typeof data === "string" ? data : JSON.stringify(data)
  return event === null ? `data: ${body}` : `event: ${event}\ndata: ${body}`
}

describe("findEventBoundary", () => {
  it("finds an LF-separated boundary", () => {
    expect(findEventBoundary("data: a\n\ndata: b")).toBe(7)
  })

  it("finds a CRLF-separated boundary", () => {
    expect(findEventBoundary("data: a\r\n\r\ndata: b")).toBe(7)
  })

  it("takes whichever boundary comes first when both appear", () => {
    expect(findEventBoundary("a\r\n\r\nb\n\nc")).toBe(1)
    expect(findEventBoundary("a\n\nb\r\n\r\nc")).toBe(1)
  })

  it("has no boundary in an incomplete buffer", () => {
    expect(findEventBoundary("data: half")).toBe(-1)
  })
})

describe("parseSseBlock", () => {
  it("defaults a frame with no event name to a delta", () => {
    expect(parseSseBlock(block(null, { text: "hello" }))).toEqual({ type: "delta", text: "hello" })
  })

  // A plain object literal answers for every key on Object.prototype, so an
  // event named `toString` used to resolve to a function and be invoked.
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty"])(
    "drops an event named %s instead of calling the prototype",
    (name) => {
      expect(parseSseBlock(block(name, { text: "hi" }))).toBeNull()
    }
  )

  it("joins a multi-line data body before parsing it", () => {
    const raw = 'event: delta\ndata: {"text":\ndata: "split"}'
    expect(parseSseBlock(raw)).toEqual({ type: "delta", text: "split" })
  })

  it("ignores comment and blank lines", () => {
    const raw = ': keep-alive\n\nevent: delta\ndata: {"text":"hi"}'
    expect(parseSseBlock(raw)).toEqual({ type: "delta", text: "hi" })
  })

  it("strips exactly one space after the data prefix", () => {
    expect(parseSseBlock("event: delta\ndata:  two spaces")).toEqual({
      type: "delta",
      text: " two spaces",
    })
  })

  it("reads a frame with an empty body as an empty payload", () => {
    expect(parseSseBlock("event: done")).toEqual({ type: "done" })
  })

  it("names a tool the server started and finished", () => {
    expect(parseSseBlock(block("tool_start", { name: "search" }))).toEqual({
      type: "tool_start",
      name: "search",
    })
    expect(parseSseBlock(block("tool_end", { name: "search" }))).toEqual({
      type: "tool_end",
      name: "search",
    })
  })

  it("has an empty tool name when the server sent none", () => {
    expect(parseSseBlock(block("tool_start", {}))).toEqual({ type: "tool_start", name: undefined })
  })

  it("reads a status key with its string and number params", () => {
    expect(
      parseSseBlock(block("status", { key: "searching", params: { n: 3, q: "karma" } }))
    ).toEqual({ type: "status", key: "searching", params: { n: 3, q: "karma" } })
  })

  it("has no status params when none are usable", () => {
    expect(parseSseBlock(block("status", { key: "thinking", params: { bad: { a: 1 } } }))).toEqual({
      type: "status",
      key: "thinking",
      params: undefined,
    })
    expect(parseSseBlock(block("status", { key: "thinking", params: [1, 2] }))).toEqual({
      type: "status",
      key: "thinking",
      params: undefined,
    })
  })

  it("carries a research question the model asked itself", () => {
    expect(parseSseBlock(block("research_question", { question: "  what is karma?  " }))).toEqual({
      type: "research_question",
      question: "what is karma?",
    })
  })

  it("drops a blank research question", () => {
    expect(parseSseBlock(block("research_question", { question: "   " }))).toBeNull()
  })

  it("decodes a done's alias map with its spans", () => {
    const done = parseSseBlock(
      block("done", {
        aliases: { "[1]": { track_id: "t1", start_ms: 10, end_ms: 20 }, "[2]": { track_id: "t2" } },
      })
    )
    expect(done).toEqual({
      type: "done",
      aliases: {
        "[1]": { track_id: "t1", start_ms: 10, end_ms: 20 },
        "[2]": { track_id: "t2" },
      },
    })
  })

  it("drops an alias entry with no track id or a non-object body", () => {
    expect(
      parseSseBlock(block("done", { aliases: { a: { start_ms: 1 }, b: "nope", c: null } }))
    ).toEqual({ type: "done", aliases: {} })
  })

  it("has no aliases when the field is not a map", () => {
    expect(parseSseBlock(block("done", { aliases: ["[1]"] }))).toEqual({ type: "done" })
  })

  it("drops a non-JSON payload on a non-delta event", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(parseSseBlock("event: done\ndata: not json")).toBeNull()
    warn.mockRestore()
  })

  it("drops an event name this build does not know", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(parseSseBlock(block("telemetry", { x: 1 }))).toBeNull()
    warn.mockRestore()
  })
})

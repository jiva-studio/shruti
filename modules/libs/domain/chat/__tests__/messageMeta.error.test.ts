import { describe, expect, it } from "vitest"
import { parseMeta, wrapMeta } from "../messageMeta.js"

/**
 * The writer/reader contract for the `error` field of the meta envelope.
 *
 * `runChatTurn` computes the truncation reason as
 * `sawTurnsLimit ? "turns" : (lastError?.code ?? "stream")` — an OPEN
 * vocabulary, because `lastError.code` is whatever the server reported. The
 * parser used to whitelist `"stream"` and `"turns"` only, so every other
 * reason round-tripped to `undefined`: an answer cut short by a server
 * failure came back from SQLite indistinguishable from a complete one, with
 * no interrupted suffix and no Retry (#1891).
 *
 * This is the test that would have caught it — it asserts the round trip for
 * every reason the writer can emit, including codes this build has never
 * heard of.
 */

/** Every reason `runChatTurn` can put on the wire: the two it mints itself,
 *  plus the server error codes that reach it as `lastError.code`. */
const WRITER_REASONS = [
  "stream",
  "turns",
  "agent_error",
  "turn_timeout",
  "chat_unavailable",
  "rate_limited",
  "http_500",
  "network",
] as const

describe("messageMeta — truncated error round trip", () => {
  it.each(WRITER_REASONS)("survives wrapMeta → parseMeta with reason %s", (reason) => {
    const parsed = parseMeta(wrapMeta({ error: { kind: "truncated", reason } }))
    expect(parsed.error).toEqual({ kind: "truncated", reason })
  })

  it("keeps a server code this build has never seen", () => {
    // The server may grow a new code at any time; the client must still show
    // the bubble as interrupted rather than silently promote it to complete.
    const parsed = parseMeta(wrapMeta({ error: { kind: "truncated", reason: "moon_phase" } }))
    expect(parsed.error).toEqual({ kind: "truncated", reason: "moon_phase" })
  })

  it("round-trips a user-initiated stop", () => {
    expect(parseMeta(wrapMeta({ error: { kind: "stopped" } })).error).toEqual({ kind: "stopped" })
  })

  it("drops a `failed` marker — failed bubbles are memory-only history", () => {
    expect(parseMeta(wrapMeta({ error: { kind: "failed", code: "rate_limited" } })).error).toBe(
      undefined
    )
  })

  it("rejects a truncated marker with no usable reason", () => {
    for (const raw of [
      '{"_v":1,"data":{"error":{"kind":"truncated"}}}',
      '{"_v":1,"data":{"error":{"kind":"truncated","reason":""}}}',
      '{"_v":1,"data":{"error":{"kind":"truncated","reason":7}}}',
      '{"_v":1,"data":{"error":{"kind":"nonsense","reason":"stream"}}}',
    ]) {
      expect(parseMeta(raw).error).toBe(undefined)
    }
  })
})

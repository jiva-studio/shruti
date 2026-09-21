import { describe, expect, it } from "vitest"
import { CURRENT_META_V, EMPTY_META, parseMeta, wrapMeta } from "../messageMeta.js"

const envelope = (data: unknown, v: unknown = CURRENT_META_V) => JSON.stringify({ _v: v, data })

describe("parseMeta — the envelope", () => {
  it.each([
    ["a non-string", 42],
    ["an empty string", ""],
    ["unparseable JSON", "{oops"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["no version", JSON.stringify({ data: {} })],
    ["a non-numeric version", envelope({}, "1")],
  ])("renders empty for %s", (_label, raw) => {
    expect(parseMeta(raw)).toEqual(EMPTY_META)
  })

  it("renders empty for a version a newer client wrote", () => {
    expect(parseMeta(envelope({ followups: ["x"] }, CURRENT_META_V + 1))).toEqual(EMPTY_META)
  })

  it("accepts an older version rather than discarding the row", () => {
    expect(parseMeta(envelope({ followups: ["x"] }, 0)).followups).toEqual(["x"])
  })

  it("treats a missing or non-object data as no cards", () => {
    expect(parseMeta(envelope(undefined))).toEqual(EMPTY_META)
    expect(parseMeta(envelope([1, 2]))).toEqual(EMPTY_META)
  })

  it("ignores keys this build does not know", () => {
    const parsed = parseMeta(envelope({ followups: ["a"], somethingNew: { x: 1 } }))
    expect(parsed.followups).toEqual(["a"])
  })
})

describe("parseMeta — followups", () => {
  it("keeps only the non-empty strings", () => {
    expect(parseMeta(envelope({ followups: ["a", "", null, 7, "b"] })).followups).toEqual([
      "a",
      "b",
    ])
  })

  it("is empty when the value is not a list", () => {
    expect(parseMeta(envelope({ followups: "a" })).followups).toEqual([])
  })
})

describe("parseMeta — error", () => {
  it("keeps any server reason, not a whitelist of two", () => {
    for (const reason of ["turns", "stream", "agent_error", "turn_timeout", "chat_unavailable"]) {
      expect(parseMeta(envelope({ error: { kind: "truncated", reason } })).error).toEqual({
        kind: "truncated",
        reason,
      })
    }
  })

  it("drops a truncated marker with no reason", () => {
    expect(parseMeta(envelope({ error: { kind: "truncated", reason: "" } })).error).toBeUndefined()
    expect(parseMeta(envelope({ error: { kind: "truncated" } })).error).toBeUndefined()
  })

  it("round-trips a user stop", () => {
    expect(parseMeta(envelope({ error: { kind: "stopped" } })).error).toEqual({ kind: "stopped" })
  })

  it("does not restore a failed bubble", () => {
    expect(parseMeta(envelope({ error: { kind: "failed" } })).error).toBeUndefined()
  })
})

describe("parseMeta — focus", () => {
  const full = {
    trackId: "t1",
    startMs: 10,
    endMs: 20,
    text: "a fragment",
    sourceKey: "k",
    trackTitle: "Title",
    authorName: "Author",
    date: "2020-01-01",
    location: "Vrindavan",
  }

  it("keeps every optional field the writer supplied", () => {
    expect(parseMeta(envelope({ focus: full })).focus).toEqual(full)
  })

  it("keeps only the required fields when the rest are absent", () => {
    const { trackId, startMs, endMs, text } = full
    expect(parseMeta(envelope({ focus: { trackId, startMs, endMs, text } })).focus).toEqual({
      trackId,
      startMs,
      endMs,
      text,
    })
  })

  it.each([
    ["a missing trackId", { startMs: 1, endMs: 2, text: "x" }],
    ["a non-numeric span", { trackId: "t", startMs: "1", endMs: 2, text: "x" }],
    ["a missing text", { trackId: "t", startMs: 1, endMs: 2 }],
    ["an array", []],
    ["a string", "focus"],
  ])("drops a focus with %s", (_label, raw) => {
    expect(parseMeta(envelope({ focus: raw })).focus).toBeUndefined()
  })
})

describe("parseMeta — feedback", () => {
  it("keeps the vote, its category and its comment", () => {
    expect(
      parseMeta(envelope({ feedback: { state: "down", category: "bad_citations", comment: "no" } }))
        .feedback
    ).toEqual({ state: "down", category: "bad_citations", comment: "no" })
  })

  it("drops a category outside the vocabulary but keeps the vote", () => {
    expect(
      parseMeta(envelope({ feedback: { state: "up", category: "invented" } })).feedback
    ).toEqual({ state: "up" })
  })

  it("drops an empty comment", () => {
    expect(parseMeta(envelope({ feedback: { state: "up", comment: "" } })).feedback).toEqual({
      state: "up",
    })
  })

  it("drops a vote that is neither up nor down", () => {
    expect(parseMeta(envelope({ feedback: { state: "meh" } })).feedback).toBeUndefined()
  })
})

describe("parseMeta — aliases", () => {
  it("keeps the span when the writer had one", () => {
    expect(
      parseMeta(envelope({ aliases: { A: { trackId: "t", startMs: 1, endMs: 2 } } })).aliases
    ).toEqual({ A: { trackId: "t", startMs: 1, endMs: 2 } })
  })

  it("keeps a bare alias with no span", () => {
    expect(parseMeta(envelope({ aliases: { A: { trackId: "t" } } })).aliases).toEqual({
      A: { trackId: "t" },
    })
  })

  it("skips an entry with no track and reports nothing when none survive", () => {
    expect(parseMeta(envelope({ aliases: { A: { startMs: 1 } } })).aliases).toBeUndefined()
    expect(parseMeta(envelope({ aliases: { A: { trackId: "t" }, B: {} } })).aliases).toEqual({
      A: { trackId: "t" },
    })
  })
})

describe("parseMeta — attributes", () => {
  it("keeps a single value as a string and a list as a list", () => {
    const parsed = parseMeta(
      envelope({
        attributes: {
          topic: { value: "bhakti", label: "Topic", explicit: true },
          authors: { value: ["a", "b"], label: "Authors" },
        },
      })
    )
    expect(parsed.attributes).toEqual({
      topic: { value: "bhakti", label: "Topic", explicit: true },
      authors: { value: ["a", "b"], label: "Authors", explicit: false },
    })
  })

  it("trims, drops blanks and de-duplicates keeping order", () => {
    expect(
      parseMeta(envelope({ attributes: { a: { value: [" x ", "y", "x", "  ", 7] } } })).attributes
    ).toEqual({ a: { value: ["x", "y"], label: "", explicit: false } })
  })

  it("drops an attribute whose value cleans to nothing", () => {
    expect(parseMeta(envelope({ attributes: { a: { value: ["  "] } } })).attributes).toBeUndefined()
    expect(parseMeta(envelope({ attributes: { a: { value: 7 } } })).attributes).toBeUndefined()
  })

  it("carries a key this build does not understand", () => {
    expect(parseMeta(envelope({ attributes: { invented: { value: "v" } } })).attributes).toEqual({
      invented: { value: "v", label: "", explicit: false },
    })
  })
})

describe("wrapMeta", () => {
  it("serialises a card-less message to exactly the empty envelope", () => {
    expect(wrapMeta({})).toBe(`{"_v":${CURRENT_META_V},"data":{}}`)
  })

  it("omits an empty collection rather than writing an empty object", () => {
    expect(wrapMeta({ actions: {}, followups: [], aliases: {}, attributes: {} })).toBe(
      `{"_v":${CURRENT_META_V},"data":{}}`
    )
  })

  it("round-trips everything parseMeta knows", () => {
    const payload = {
      followups: ["ask more"],
      error: { kind: "truncated" as const, reason: "stream" },
      aliases: { A: { trackId: "t", startMs: 1, endMs: 2 } },
      focus: { trackId: "t1" as never, startMs: 0, endMs: 5, text: "x" },
      feedback: { state: "up" as const },
      attributes: { topic: { value: "bhakti", label: "Topic", explicit: true } },
    }
    const parsed = parseMeta(wrapMeta(payload))
    expect(parsed.followups).toEqual(payload.followups)
    expect(parsed.error).toEqual(payload.error)
    expect(parsed.aliases).toEqual(payload.aliases)
    expect(parsed.focus).toEqual(payload.focus)
    expect(parsed.feedback).toEqual(payload.feedback)
    expect(parsed.attributes).toEqual(payload.attributes)
  })

  it("writes a stopped marker so the partial bubble survives a cold start", () => {
    expect(parseMeta(wrapMeta({ error: { kind: "stopped" } })).error).toEqual({ kind: "stopped" })
  })
})

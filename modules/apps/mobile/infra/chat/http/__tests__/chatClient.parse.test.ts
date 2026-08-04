import { describe, expect, it } from "vitest"
import { aggregateAttributes, parseStoredFrame, toWireTurns } from "../chatClient.js"

/**
 * Exercises the SSE wire decoder via the exported `parseStoredFrame`, which
 * routes a `{event, data}` frame through the same `parseSseBlock` +
 * per-kind validators the live stream uses. This is the one seam where a
 * server protocol change silently corrupts every card, so the validators'
 * reject paths are pinned here. No mocking — pure functions.
 */
function parse(event: string, data: unknown) {
  return parseStoredFrame({ event, data: typeof data === "string" ? data : JSON.stringify(data) })
}

describe("parseStoredFrame — framing & delta", () => {
  it("surfaces a non-JSON delta payload as raw text", () => {
    expect(parse("delta", "raw chunk")).toEqual({ type: "delta", text: "raw chunk" })
  })

  it("reads a JSON delta's text field", () => {
    expect(parse("delta", { text: "Hi" })).toEqual({ type: "delta", text: "Hi" })
  })

  it("drops a non-delta event with a malformed (non-JSON) payload", () => {
    expect(parse("action", "{not json")).toBeNull()
  })

  it("returns null for an unknown event name", () => {
    expect(parse("teleport", {})).toBeNull()
  })
})

describe("parseStoredFrame — card-action validators", () => {
  it("drops a cite_transcript with empty text", () => {
    expect(
      parse("action", {
        kind: "cite_transcript",
        id: "a1",
        payload: { track_id: "t", start_ms: 0, end_ms: 1, text: "   " },
      })
    ).toBeNull()
  })

  it("accepts a valid cite_transcript and keeps mt + text_original", () => {
    const ev = parse("action", {
      kind: "cite_transcript",
      id: "a1",
      payload: {
        track_id: "t",
        start_ms: 0,
        end_ms: 1,
        text: "soul",
        mt: true,
        text_original: "душа",
      },
    })
    expect(ev).toMatchObject({
      type: "action",
      payload: {
        kind: "cite_transcript",
        payload: { text: "soul", mt: true, text_original: "душа" },
      },
    })
  })

  it("drops a commentary with no ref", () => {
    expect(parse("action", { kind: "commentary", id: "a1", payload: { text: "p" } })).toBeNull()
  })

  it("accepts a chapter with an EMPTY region_token (book-level region)", () => {
    const ev = parse("action", {
      kind: "chapter",
      id: "a1",
      payload: {
        source_id: "bg",
        region_token: "",
        chapters: [{ tokens: "1", title: "Creation" }],
      },
    })
    expect(ev).toMatchObject({ payload: { payload: { region_token: "" } } })
  })

  it("drops a chapter with no chapter rows", () => {
    expect(
      parse("action", {
        kind: "chapter",
        id: "a1",
        payload: { source_id: "bg", region_token: "1", chapters: [] },
      })
    ).toBeNull()
  })

  it("drops media of unknown type / missing url", () => {
    expect(
      parse("action", { kind: "media", id: "a1", payload: { id: "m", url: "u", type: "gif" } })
    ).toBeNull()
    expect(
      parse("action", { kind: "media", id: "a1", payload: { id: "m", url: "", type: "video" } })
    ).toBeNull()
  })

  it("rejects an enable_daily_reminder out-of-range time -> 07:00 default", () => {
    expect(
      parse("action", { kind: "enable_daily_reminder", id: "a1", payload: { time: "25:99" } })
    ).toMatchObject({ payload: { payload: { time: "07:00" } } })
  })

  it("rejects a flat (non-v1) action shape lacking the nested payload", () => {
    expect(parse("action", { kind: "upgrade_to_pro", id: "a1", reason: "x" })).toBeNull()
  })

  it("drops a share_pdf with zero valid items", () => {
    expect(
      parse("action", { kind: "share_pdf", id: "a1", payload: { items: [{ track_id: "" }] } })
    ).toBeNull()
  })
})

describe("parseStoredFrame — research_source rename", () => {
  it("renames wire `kind` to `sourceKind`", () => {
    expect(parse("research_source", { kind: "verse", id: "s1", label: "BG 2.13" })).toEqual({
      type: "research_source",
      sourceKind: "verse",
      id: "s1",
      label: "BG 2.13",
    })
  })

  it("drops an unknown source kind", () => {
    expect(parse("research_source", { kind: "podcast", id: "s1" })).toBeNull()
  })

  it("drops a research_source with no id", () => {
    expect(parse("research_source", { kind: "verse", id: "  " })).toBeNull()
  })
})

describe("parseStoredFrame — usage", () => {
  it("drops a usage frame with a non-positive field", () => {
    expect(parse("usage", { current: 1, limit: 0, resets_at_epoch: 999 })).toBeNull()
    expect(parse("usage", { current: -1, limit: 50, resets_at_epoch: 999 })).toBeNull()
  })

  it("reads snake_case resets_at_epoch", () => {
    expect(parse("usage", { scope: "chat", current: 3, limit: 50, resets_at_epoch: 999 })).toEqual({
      type: "usage",
      scope: "chat",
      current: 3,
      limit: 50,
      resetsAtEpoch: 999,
    })
  })
})

describe("parseStoredFrame — error", () => {
  it("hydrates tier / resets_at_epoch / current / limit / key_type from snake_case", () => {
    expect(
      parse("error", {
        code: "rate_limited",
        message: "slow down",
        tier: "free",
        resets_at_epoch: 1234,
        current: 50,
        limit: 50,
        key_type: "user",
      })
    ).toMatchObject({
      type: "error",
      code: "rate_limited",
      tier: "free",
      resetsAtEpoch: 1234,
      current: 50,
      limit: 50,
      keyType: "user",
    })
  })

  it("coerces a key_type other than user/ip to undefined", () => {
    const ev = parse("error", { code: "x", key_type: "device" })
    expect(ev).toMatchObject({ type: "error", code: "x" })
    expect((ev as { keyType?: string }).keyType).toBeUndefined()
  })
})

describe("parseStoredFrame — done aliases", () => {
  it("decodes a done with no aliases", () => {
    expect(parse("done", {})).toEqual({ type: "done" })
  })
})

describe("parseStoredFrame — done attributes", () => {
  it("decodes the settled attributes", () => {
    expect(
      parse("done", {
        attributes: { reply_language: { value: "ru", label: "Русский", explicit: true } },
      })
    ).toEqual({
      type: "done",
      attributes: { reply_language: { value: "ru", label: "Русский", explicit: true } },
    })
  })

  it("omits them when the server settled nothing", () => {
    // Normal on a bare «БГ 2.13»: the client keeps what it already had.
    expect(parse("done", {})).toEqual({ type: "done" })
  })

  it("keeps an attribute this build knows nothing about", () => {
    // The point of a keyed map: the server can add one without a client
    // release, and an older client must carry it forward rather than erase it.
    expect(parse("done", { attributes: { future_thing: { value: "42" } } })).toEqual({
      type: "done",
      attributes: { future_thing: { value: "42", label: "", explicit: false } },
    })
  })

  it("drops an entry with no value rather than storing an empty one", () => {
    expect(parse("done", { attributes: { reply_language: { value: "" } } })).toEqual({
      type: "done",
    })
    expect(parse("done", { attributes: { reply_language: "ru" } })).toEqual({ type: "done" })
    expect(parse("done", { attributes: "nope" })).toEqual({ type: "done" })
  })

  it("keeps an unknown locale — the reply language is not the UI language set", () => {
    // «Cos'è il karma?» must come back in Italian even with no Italian UI.
    expect(
      parse("done", {
        attributes: { reply_language: { value: "it", label: "Italiano", explicit: false } },
      })
    ).toEqual({
      type: "done",
      attributes: { reply_language: { value: "it", label: "Italiano", explicit: false } },
    })
  })

  it("one malformed entry does not cost the others", () => {
    expect(
      parse("done", {
        attributes: { reply_language: { value: "ru" }, broken: 7 },
      })
    ).toEqual({
      type: "done",
      attributes: { reply_language: { value: "ru", label: "", explicit: false } },
    })
  })
})

describe("toWireTurns — what the next request carries back", () => {
  const RU = { value: "ru", label: "Русский", explicit: true }

  it("sends the settled attributes on an assistant turn", () => {
    expect(
      toWireTurns([
        { role: "user", content: "отвечай по-русски" },
        { role: "assistant", content: "Хорошо.", attributes: { reply_language: RU } },
      ])
    ).toEqual([
      { role: "user", content: "отвечай по-русски" },
      { role: "assistant", content: "Хорошо.", attributes: { reply_language: RU } },
    ])
  })

  it("omits them when the turn settled none", () => {
    expect(toWireTurns([{ role: "assistant", content: "answer" }])).toEqual([
      { role: "assistant", content: "answer" },
    ])
  })

  it("never sends them on a user turn", () => {
    // Server state, not something the user can set — the server ignores a
    // user-side claim, and not sending it keeps the contract honest.
    expect(
      toWireTurns([{ role: "user", content: "hi", attributes: { reply_language: RU } }])
    ).toEqual([{ role: "user", content: "hi" }])
  })

  it("carries them alongside the alias map", () => {
    const [turn] = toWireTurns([
      {
        role: "assistant",
        content: "see [cite:1]",
        aliases: { "1": { trackId: "track_x", startMs: 1000, endMs: 2000 } },
        attributes: { reply_language: { value: "hi", label: "हिन्दी", explicit: true } },
      },
    ])
    expect(turn.aliases).toEqual({ "1": { track_id: "track_x", start_ms: 1000, end_ms: 2000 } })
    expect(turn.attributes).toEqual({
      reply_language: { value: "hi", label: "हिन्दी", explicit: true },
    })
  })
})

describe("aggregateAttributes — the metadata the request carries", () => {
  const asked = (value: string) => ({ value, label: value, explicit: true })
  const typed = (value: string) => ({ value, label: value, explicit: false })

  it("is undefined when the conversation settled nothing", () => {
    expect(
      aggregateAttributes([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ])
    ).toBeUndefined()
  })

  it("carries a setting from the very first turn of a long dialogue", () => {
    // The whole reason this exists: the request can only hold 20 messages, so
    // the server would never see turn 1 again.
    const messages = [
      {
        role: "assistant" as const,
        content: "Хорошо.",
        attributes: { reply_language: asked("ru") },
      },
      ...Array.from({ length: 30 }, (_, i) => ({
        role: "assistant" as const,
        content: `answer ${i}`,
      })),
    ]
    expect(aggregateAttributes(messages)).toEqual({ reply_language: asked("ru") })
  })

  it("a later turn wins", () => {
    expect(
      aggregateAttributes([
        { role: "assistant", content: "a", attributes: { reply_language: asked("ru") } },
        { role: "assistant", content: "b", attributes: { reply_language: asked("en") } },
      ])
    ).toEqual({ reply_language: asked("en") })
  })

  it("a later inference does not overwrite what the user stated", () => {
    // Same rule as the server's merge — the two folds must not disagree.
    expect(
      aggregateAttributes([
        { role: "assistant", content: "a", attributes: { reply_language: asked("ru") } },
        { role: "assistant", content: "b", attributes: { reply_language: typed("en") } },
      ])
    ).toEqual({ reply_language: asked("ru") })
  })

  it("folds different keys independently", () => {
    expect(
      aggregateAttributes([
        { role: "assistant", content: "a", attributes: { reply_language: asked("ru") } },
        { role: "assistant", content: "b", attributes: { tone: typed("brief") } },
      ])
    ).toEqual({ reply_language: asked("ru"), tone: typed("brief") })
  })

  it("ignores attributes on a user turn", () => {
    expect(
      aggregateAttributes([
        { role: "user", content: "hi", attributes: { reply_language: asked("de") } },
      ])
    ).toBeUndefined()
  })
})

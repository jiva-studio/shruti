import { describe, expect, it } from "vitest"
import { clearTurnCards, createTurnCards, foldAction, foldAliases } from "../chatActionFold.js"

describe("foldAction", () => {
  it("fans an outline out by track, not into the action map", () => {
    const folded = foldAction({
      kind: "outline",
      id: "a1",
      payload: { trackId: "t1", items: [] },
    } as never)
    expect(folded).toMatchObject({ slot: "outlines", key: "t1" })
  })

  it("keys a verse by source and tokens, and camel-cases the wire", () => {
    const folded = foldAction({
      kind: "verse",
      id: "a2",
      payload: {
        source_id: "bg",
        tokens: "2.13",
        addr_label: "BG 2.13",
        sanskrit: "देहिनो",
        transliteration: "dehino",
        transliteration_original: "dehino",
        translation: { en: "As the embodied soul" },
        audio_url: "u",
        mt: true,
      },
    } as never)
    expect(folded?.key).toBe("bg|2.13")
    expect(folded?.body).toMatchObject({ addrLabel: "BG 2.13", audioUrl: "u", mt: true })
  })

  it("keys a citation by track and its span", () => {
    const folded = foldAction({
      kind: "cite_transcript",
      id: "a3",
      payload: { track_id: "t9", start_ms: 100, end_ms: 200, text: "x" },
    } as never)
    expect(folded?.key).toBe("t9|100-200")
  })

  // An absent flag stays absent rather than becoming `mt: undefined`: the
  // card reads the two differently.
  it("leaves the translation flag off a chapter list that has none", () => {
    const folded = foldAction({
      kind: "chapter",
      id: "a4",
      payload: {
        source_id: "sb",
        region_token: "1",
        region_label: "Canto 1",
        chapters: [{ tokens: "1.1", title: "Questions" }],
      },
    } as never)
    expect(folded?.body).not.toHaveProperty("mt")
    expect(folded?.body).toMatchObject({ chapters: [{ tokens: "1.1", title: "Questions" }] })
  })

  it("drops an action kind this build does not know", () => {
    expect(foldAction({ kind: "teleport", id: "a5", payload: {} } as never)).toBeNull()
  })

  it("flattens an interactive widget into the shape the card reads", () => {
    const folded = foldAction({
      kind: "upgrade_to_pro",
      id: "a6",
      payload: { reason: "quota" },
    } as never)
    expect(folded).toMatchObject({
      slot: "actions",
      key: "a6",
      body: { kind: "upgrade_to_pro", id: "a6", reason: "quota" },
    })
  })
})

describe("clearTurnCards", () => {
  it("empties every slot, so a tool re-run keeps nothing of the first pass", () => {
    const cards = createTurnCards()
    cards.actions.a = { kind: "upgrade_to_pro", id: "a", reason: "r" } as never
    cards.verses.v = {} as never
    clearTurnCards(cards)
    expect(Object.keys(cards.actions)).toEqual([])
    expect(Object.keys(cards.verses)).toEqual([])
  })
})

describe("foldAliases", () => {
  it("carries a span only when the server sent one", () => {
    const out = foldAliases({ "1": { track_id: "t1" }, "2": { track_id: "t2", start_ms: 5 } })
    expect(out["1"]).toEqual({ trackId: "t1" })
    expect(out["2"]).toEqual({ trackId: "t2", startMs: 5 })
  })
})

import { describe, expect, it } from "vitest"
import { extractFollowups, parseChatMarkers } from "../useMarkerParser.js"

/**
 * Marker grammar coverage. The parser is the bridge between LLM-emitted
 * inline markers and the bubble's component renderer — a regex regression
 * here silently turns markers into text tokens.
 */
describe("parseChatMarkers — action markers", () => {
  it("recognises create_playlist (snake_case)", () => {
    const tokens = parseChatMarkers("ok [action:create_playlist|id=abc12345]")
    const action = tokens.find((t) => t.kind === "action")
    expect(action).toBeTruthy()
    if (action && action.kind === "action") {
      expect(action.actionKind).toBe("create_playlist")
      expect(action.actionId).toBe("abc12345")
    }
  })

  it("rejects legacy kebab-case form (create-playlist)", () => {
    // Snake-only since Etap «protocol cleanup». Kebab-form markers from
    // older persisted messages parse to no action token (text only).
    const t1 = parseChatMarkers("[action:create-playlist|id=abc12345]")
    expect(t1.find((t) => t.kind === "action")).toBeUndefined()
  })

  it("ignores the removed save_note action kind", () => {
    // save_note was removed in favour of the CitationChip action-sheet
    // path. Old persisted messages with the marker render as plain text.
    const tokens = parseChatMarkers("[action:save_note|id=note_ABC_1]")
    expect(tokens.find((t) => t.kind === "action")).toBeUndefined()
  })

  it("rejects malformed markers — wrong delimiter, spaces inside id", () => {
    const tokens1 = parseChatMarkers("[action:create_playlist id=abc12345]")
    const tokens2 = parseChatMarkers("[action:create_playlist|id=abc 12345]")
    expect(tokens1.find((t) => t.kind === "action")).toBeUndefined()
    expect(tokens2.find((t) => t.kind === "action")).toBeUndefined()
  })

  it("does not match when kind starts with a digit", () => {
    const tokens = parseChatMarkers("[action:42bad|id=abc12345]")
    expect(tokens.find((t) => t.kind === "action")).toBeUndefined()
  })

  it("finds multiple action markers in one message", () => {
    const tokens = parseChatMarkers(
      "first [action:create_playlist|id=aaa] then [action:share_pdf|id=bbb]"
    )
    const actions = tokens.filter((t) => t.kind === "action")
    expect(actions).toHaveLength(2)
  })

  it("recognises share_pdf (PDF download / share card)", () => {
    const tokens = parseChatMarkers("Готово [action:share_pdf|id=ab12cd34]")
    const action = tokens.find((t) => t.kind === "action")
    expect(action).toBeTruthy()
    if (action && action.kind === "action") {
      expect(action.actionKind).toBe("share_pdf")
      expect(action.actionId).toBe("ab12cd34")
    }
  })
})

describe("parseChatMarkers — followup markers (strip from prose)", () => {
  it("strips [followup:..] markers from the rendered token stream", () => {
    const tokens = parseChatMarkers(
      "Глава 2 раскрывает санкхья-йогу.\n[followup:А что в главе 3?]\n[followup:Сделай PDF]"
    )
    // No token for the followup itself.
    expect(tokens.every((t) => t.kind !== "action")).toBe(true)
    const textHtml = tokens
      .filter((t): t is Extract<typeof t, { kind: "text" }> => t.kind === "text")
      .map((t) => t.html)
      .join(" ")
    expect(textHtml).not.toContain("[followup:")
    expect(textHtml).toContain("санкхья-йогу")
  })

  it("leaves malformed followup markers in prose (strict parser)", () => {
    // `]` inside text — the regex matches "Глава 2.20" and the trailing
    // `]` leaks; that's the documented strict-parser behaviour.
    const tokens = parseChatMarkers("ок [followup:Узнай про [Глава 2.20]]")
    const html = tokens
      .filter((t): t is Extract<typeof t, { kind: "text" }> => t.kind === "text")
      .map((t) => t.html)
      .join("")
    // Trailing `]` leaks into prose since the parser stops at the inner `]`.
    expect(html).toContain("]")
  })
})

describe("extractFollowups", () => {
  it("returns chip texts in order", () => {
    const chips = extractFollowups(
      "Some prose.\n[followup:Сделай PDF]\n[followup:А что в главе 3?]"
    )
    expect(chips).toEqual(["Сделай PDF", "А что в главе 3?"])
  })

  it("caps at 3 even if more markers are present", () => {
    const chips = extractFollowups(
      "[followup:one][followup:two][followup:three][followup:four][followup:five]"
    )
    expect(chips).toHaveLength(3)
    expect(chips).toEqual(["one", "two", "three"])
  })

  it("rejects empty text (no chip emitted)", () => {
    const chips = extractFollowups("[followup:]")
    expect(chips).toEqual([])
  })

  it("rejects text containing pipe (drops the chip)", () => {
    // Pipe is the marker field separator elsewhere; tolerating it
    // inside followup text would force the LLM to escape and create
    // grammar bleed with `[action:..|id=..]`.
    const chips = extractFollowups("[followup:Сделай PDF | плейлист]")
    expect(chips).toEqual([])
  })

  it("does not break on `]` inside text — strict stop on first `]`", () => {
    const chips = extractFollowups("[followup:Глава [2.20]]")
    expect(chips).toEqual(["Глава [2.20"])
  })

  it("trims surrounding whitespace from the chip text", () => {
    const chips = extractFollowups("[followup:   Сделай PDF   ]")
    expect(chips).toEqual(["Сделай PDF"])
  })

  it("returns empty array on empty / non-string input", () => {
    expect(extractFollowups("")).toEqual([])
  })
})

describe("parseChatMarkers — library verse markers", () => {
  it("parses [verse:source/tokens|caption]", () => {
    const tokens = parseChatMarkers("Вот стих [verse:source_dsicuBsFvinZ/2.13|БГ 2.13]")
    const verse = tokens.find((t) => t.kind === "verse")
    expect(verse).toBeTruthy()
    if (verse && verse.kind === "verse") {
      expect(verse.sourceId).toBe("source_dsicuBsFvinZ")
      expect(verse.tokens).toBe("2.13")
      expect(verse.caption).toBe("БГ 2.13")
    }
  })

  it('accepts compound verse tokens (e.g. "1.2.28,1.2.29")', () => {
    const tokens = parseChatMarkers("[verse:source_abc/1.2.28,1.2.29|SB 1.2.28-29]")
    const verse = tokens.find((t) => t.kind === "verse")
    expect(verse?.kind).toBe("verse")
    if (verse?.kind === "verse") expect(verse.tokens).toBe("1.2.28,1.2.29")
  })

  it("treats verse caption as optional", () => {
    const tokens = parseChatMarkers("[verse:source_x/5.1]")
    const verse = tokens.find((t) => t.kind === "verse")
    if (verse?.kind === "verse") expect(verse.caption).toBe("")
  })
})

describe("parseChatMarkers — markdown blockquote", () => {
  it("parses a simple blockquote run into a 'quote' token", () => {
    const tokens = parseChatMarkers(
      "Прабхупада говорит:\n\n> Каждое живое существо является душой\n> *(комментарий к БГ 2.13)*\n\nТо же в письме."
    )
    const quote = tokens.find((t) => t.kind === "quote")
    expect(quote).toBeTruthy()
    if (quote?.kind === "quote") {
      expect(quote.bodyHtml).toContain("Каждое живое существо")
      // Parens around the addr are preserved verbatim — they're part of
      // the agent's intentional visual styling, not parser noise.
      expect(quote.attributionHtml).toBe("(комментарий к БГ 2.13)")
    }
  })

  it("treats a single-line blockquote without italic line as body-only", () => {
    const tokens = parseChatMarkers("> short note")
    const quote = tokens.find((t) => t.kind === "quote")
    if (quote?.kind === "quote") {
      expect(quote.bodyHtml).toContain("short note")
      expect(quote.attributionHtml).toBeUndefined()
    }
  })

  it("preserves prose before and after the blockquote", () => {
    const tokens = parseChatMarkers("Intro.\n\n> body\n> *(addr)*\n\nOutro.")
    expect(tokens[0]?.kind).toBe("text")
    expect(tokens[1]?.kind).toBe("quote")
    expect(tokens[2]?.kind).toBe("text")
  })
})

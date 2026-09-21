import { describe, expect, it } from "vitest"
import { extractFollowups, parseChatMarkers, type ChatToken } from "../parse.js"

function kinds(tokens: ChatToken[]): string[] {
  return tokens.map((t) => t.kind)
}

function only<K extends ChatToken["kind"]>(
  input: string,
  kind: K
): Extract<ChatToken, { kind: K }> {
  const tok = parseChatMarkers(input).find((t) => t.kind === kind)
  if (!tok) throw new Error(`no ${kind} token in ${JSON.stringify(input)}`)
  return tok as Extract<ChatToken, { kind: K }>
}

describe("parseChatMarkers — prose", () => {
  it("has nothing to render for an empty message", () => {
    expect(parseChatMarkers("")).toEqual([])
  })

  it("renders plain prose as one html token", () => {
    expect(parseChatMarkers("The soul is **eternal**.")).toEqual([
      { kind: "text", html: "The soul is <strong>eternal</strong>." },
    ])
  })

  it("drops the blank line an answer trails off with", () => {
    expect(parseChatMarkers("Hare Krishna.\n\n")).toEqual([{ kind: "text", html: "Hare Krishna." }])
  })

  it("keeps the prose on both sides of a marker", () => {
    expect(kinds(parseChatMarkers("Before [card:t1] after"))).toEqual(["text", "cards", "text"])
  })
})

describe("parseChatMarkers — citations", () => {
  it("reads the track, the window and the caption off a cite", () => {
    expect(only("[cite:BG_1972_01.05@1000-4500|on surrender]", "cite")).toEqual({
      kind: "cite",
      trackId: "BG_1972_01.05",
      startMs: 1000,
      endMs: 4500,
      caption: "on surrender",
    })
  })

  it("leaves the caption empty when the marker carried none", () => {
    expect(only("[cite:t1@0-100]", "cite").caption).toBe("")
  })

  it("trims the caption the model padded", () => {
    expect(only("[cite:t1@0-100|  on surrender  ]", "cite").caption).toBe("on surrender")
  })
})

describe("parseChatMarkers — track cards", () => {
  it("folds a run of cards into one stack", () => {
    expect(parseChatMarkers("[card:t1][card:t2][card:t3]")).toEqual([
      { kind: "cards", trackIds: ["t1", "t2", "t3"] },
    ])
  })

  it("folds cards that are only separated by blank lines", () => {
    expect(parseChatMarkers("[card:t1]\n\n[card:t2]")).toEqual([
      { kind: "cards", trackIds: ["t1", "t2"] },
    ])
  })

  it("keeps cards apart when prose stands between them", () => {
    const tokens = parseChatMarkers("[card:t1] and also [card:t2]")

    expect(tokens).toEqual([
      { kind: "cards", trackIds: ["t1"] },
      { kind: "text", html: "and also" },
      { kind: "cards", trackIds: ["t2"] },
    ])
  })

  it("strips the gap a card leaves against neighbouring prose", () => {
    expect(parseChatMarkers("Listen to this:\n\n[card:t1]\n\nIt is short.")).toEqual([
      { kind: "text", html: "Listen to this:" },
      { kind: "cards", trackIds: ["t1"] },
      { kind: "text", html: "It is short." },
    ])
  })
})

describe("parseChatMarkers — widgets", () => {
  it("reads an outline marker", () => {
    expect(only("[outline:BG_1972_01.05]", "outline")).toEqual({
      kind: "outline",
      trackId: "BG_1972_01.05",
    })
  })

  it("reads a verse address, combined verses included", () => {
    expect(only("[verse:source_abc123/1.2.28,1.2.29|ŚB 1.2.28]", "verse")).toEqual({
      kind: "verse",
      sourceId: "source_abc123",
      tokens: "1.2.28,1.2.29",
      caption: "ŚB 1.2.28",
    })
  })

  it("accepts a book-level chapter region with no token at all", () => {
    expect(only("[chapter:source_bg/|Bhagavad-gita]", "chapter")).toEqual({
      kind: "chapter",
      sourceId: "source_bg",
      regionToken: "",
      caption: "Bhagavad-gita",
    })
  })

  it("reads a media id", () => {
    expect(only("[media:clip-2024.07|morning walk]", "media")).toEqual({
      kind: "media",
      mediaId: "clip-2024.07",
      caption: "morning walk",
    })
  })

  it("reads a commentary ref as a number", () => {
    expect(only("[commentary:7]", "commentary")).toEqual({ kind: "commentary", ref: 7 })
  })

  it("reads the window off a digest marker", () => {
    expect(only("[digest:1700000000000-1700604800000]", "digest")).toEqual({
      kind: "digest",
      fromMs: 1700000000000,
      toMs: 1700604800000,
    })
  })
})

describe("parseChatMarkers — actions", () => {
  it("accepts a known action kind", () => {
    expect(only("[action:share_pdf|id=abc-1]", "action")).toEqual({
      kind: "action",
      actionKind: "share_pdf",
      actionId: "abc-1",
    })
  })

  it("refuses to render an action kind it does not know", () => {
    const tokens = parseChatMarkers("[action:launch_rocket|id=abc]")

    expect(kinds(tokens)).not.toContain("action")
  })

  it("refuses the legacy kebab spelling", () => {
    expect(kinds(parseChatMarkers("[action:create-playlist|id=abc]"))).not.toContain("action")
  })
})

describe("parseChatMarkers — blockquotes", () => {
  it("lifts a quoted run out of the prose", () => {
    expect(only("> The soul is eternal.\n> It is never born.", "quote")).toEqual({
      kind: "quote",
      bodyHtml: "The soul is eternal.<br>It is never born.",
      attributionHtml: undefined,
    })
  })

  it("peels an italic closing line off as the attribution", () => {
    const quote = only("> The soul is eternal.\n> *Bhagavad-gita 2.20*", "quote")

    expect(quote.bodyHtml).toBe("The soul is eternal.")
    expect(quote.attributionHtml).toBe("Bhagavad-gita 2.20")
  })

  it("accepts the underscore spelling of the attribution", () => {
    expect(only("> The soul is eternal.\n> _BG 2.20_", "quote").attributionHtml).toBe("BG 2.20")
  })

  it("keeps a one-line italic quote as the quote itself", () => {
    const quote = only("> *The soul is eternal.*", "quote")

    expect(quote.attributionHtml).toBeUndefined()
    expect(quote.bodyHtml).toContain("The soul is eternal.")
  })

  it("keeps the paragraph break above a quote", () => {
    expect(kinds(parseChatMarkers("As Krishna says:\n\n> The soul is eternal."))).toEqual([
      "text",
      "quote",
    ])
  })
})

describe("parseChatMarkers — follow-up chips", () => {
  it("takes the chips out of the bubble text", () => {
    const tokens = parseChatMarkers("Hare Krishna. [followup:Tell me more]")

    expect(tokens).toEqual([{ kind: "text", html: "Hare Krishna." }])
  })

  it("returns each chip verbatim, in the order the answer named them", () => {
    expect(extractFollowups("[followup:First][followup:Second|full query]")).toEqual([
      "First",
      "Second|full query",
    ])
  })

  it("never floods the bubble with more than three chips", () => {
    expect(extractFollowups("[followup:a][followup:b][followup:c][followup:d]")).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("skips a chip with nothing in it", () => {
    expect(extractFollowups("[followup:   ][followup:real]")).toEqual(["real"])
  })

  it("has no chips for an empty answer", () => {
    expect(extractFollowups("")).toEqual([])
  })

  it("stops a chip at the first bracket so it cannot swallow the prose after it", () => {
    expect(extractFollowups("[followup:Tell me more] and then some prose")).toEqual([
      "Tell me more",
    ])
  })

  it("does not let a chip run across a line break", () => {
    expect(extractFollowups("[followup:Tell\nme more]")).toEqual([])
  })
})

describe("parseChatMarkers — overlapping markers", () => {
  it("keeps the first of two markers that claim the same text", () => {
    // A media marker's permissive id class also matches the cite span here.
    const tokens = parseChatMarkers("[cite:t1@0-100|x] [media:m1|y]")

    expect(kinds(tokens)).toEqual(["cite", "media"])
  })

  it("renders a marker-only answer without an empty text token", () => {
    expect(parseChatMarkers("[outline:t1]")).toEqual([{ kind: "outline", trackId: "t1" }])
  })
})

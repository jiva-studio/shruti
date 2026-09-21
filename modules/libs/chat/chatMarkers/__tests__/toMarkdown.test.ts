import { describe, expect, it } from "vitest"
import {
  messageToMarkdown,
  type MessageToMarkdownOptions,
  type VerseBodyLike,
} from "../toMarkdown.js"

const verse: VerseBodyLike = {
  addrLabel: "BG 2.13",
  sanskrit: "dehino 'smin\n\nyatha dehe",
  transliteration: "dehino 'smin yatha dehe",
  translation: { en: "As the embodied soul…", ru: "Воплощённая душа…" },
}

function convert(input: string, over: Partial<MessageToMarkdownOptions> = {}): string {
  return messageToMarkdown(input, {
    lang: "en",
    verseLookup: () => null,
    citeLookup: () => null,
    ...over,
  })
}

describe("messageToMarkdown — stripped widgets", () => {
  it("has nothing to copy from an empty message", () => {
    expect(convert("")).toBe("")
  })

  it("drops the markers that cannot travel to another app", () => {
    const input =
      "Listen: [card:t1] [outline:t1] [action:share_pdf|id=a] [followup:More] " +
      "[chapter:source_bg/2|BG] [media:m1|clip] — that is all."

    expect(convert(input)).toBe("Listen: — that is all.")
  })

  it("keeps prose and its markdown untouched", () => {
    expect(convert("The soul is **eternal**.\n\n> A quote.")).toBe(
      "The soul is **eternal**.\n\n> A quote."
    )
  })

  // Where a run of spaces is alignment, collapsing it breaks the block.
  it("leaves indented code exactly as written", () => {
    expect(convert("Prose.\n\n    const a  =  1\n")).toBe("Prose.\n\n    const a  =  1")
  })

  it("leaves a fenced block exactly as written", () => {
    expect(convert("```\nconst a  =  1\n```")).toBe("```\nconst a  =  1\n```")
  })

  it("leaves a table's columns aligned", () => {
    const table = "| name | n |\n|------|---|\n| a    | 1 |"
    expect(convert(table)).toBe(table)
  })

  it("closes the gap a stripped marker leaves between paragraphs", () => {
    expect(convert("One.\n\n[card:t1]\n\n[card:t2]\n\nTwo.")).toBe("One.\n\nTwo.")
  })
})

describe("messageToMarkdown — verses", () => {
  it("expands a verse into its own block", () => {
    expect(convert("See [verse:source_bg/2.13|BG 2.13] here.", { verseLookup: () => verse })).toBe(
      "See\n\n**BG 2.13**\n\ndehino 'smin\nyatha dehe\n\ndehino 'smin yatha dehe\n\n" +
        "As the embodied soul…\n\n here."
    )
  })

  it("picks the translation for the requested language", () => {
    const out = convert("[verse:source_bg/2.13]", { lang: "ru", verseLookup: () => verse })

    expect(out).toContain("Воплощённая душа…")
  })

  it("falls back to English for a language the verse lacks", () => {
    const out = convert("[verse:source_bg/2.13]", {
      lang: "ru",
      verseLookup: () => ({ ...verse, translation: { en: "As the embodied soul…" } }),
    })

    expect(out).toContain("As the embodied soul…")
  })

  it("would rather print an unexpected language than a dangling header", () => {
    const out = convert("[verse:source_bg/2.13]", {
      lang: "en",
      verseLookup: () => ({ ...verse, translation: { sr: "Utelovljena duša…" } }),
    })

    expect(out).toContain("Utelovljena duša…")
  })

  it("drops a verse whose body never reached the device", () => {
    expect(convert("Before [verse:source_bg/2.13|BG 2.13] after")).toBe("Before after")
  })

  it("leaves out the fields the verse does not carry", () => {
    const out = convert("[verse:source_bg/2.13]", {
      verseLookup: () => ({ addrLabel: "", sanskrit: "", transliteration: "", translation: {} }),
    })

    expect(out).toBe("")
  })
})

describe("messageToMarkdown — audio citations", () => {
  const cite = {
    text: "The soul is eternal.\n\nIt is never born.",
    trackTitle: "Morning Walk",
    authorName: "Prabhupada",
    reference: "BG 2.20",
    trackDate: "1974-05-27",
  }

  it("quotes the transcript and attributes it on its own line", () => {
    expect(convert("[cite:t1@0-100|on the soul]", { citeLookup: () => cite })).toBe(
      "> The soul is eternal.\n> It is never born.\n>\n" +
        "> _Morning Walk · Prabhupada · BG 2.20 · 1974-05-27_"
    )
  })

  it("joins only the attribution parts it has", () => {
    const out = convert("[cite:t1@0-100]", {
      citeLookup: () => ({ text: "A line.", authorName: "Prabhupada" }),
    })

    expect(out).toBe("> A line.\n>\n> _Prabhupada_")
  })

  it("falls back to the marker caption when no track meta resolved", () => {
    const out = convert("[cite:t1@0-100|on the soul]", {
      citeLookup: () => ({ text: "A line." }),
    })

    expect(out).toBe("> A line.\n>\n> _on the soul_")
  })

  it("quotes with no attribution line when there is nothing to attribute", () => {
    expect(convert("[cite:t1@0-100]", { citeLookup: () => ({ text: "A line." }) })).toBe(
      "> A line."
    )
  })

  it("drops a citation whose transcript never arrived", () => {
    expect(convert("Before [cite:t1@0-100|x] after")).toBe("Before after")
  })

  it("drops a citation whose transcript is blank", () => {
    expect(convert("Before [cite:t1@0-100] after", { citeLookup: () => ({ text: "   " }) })).toBe(
      "Before after"
    )
  })
})

describe("messageToMarkdown — commentary citations", () => {
  it("quotes the purport with its author and reference", () => {
    const out = convert("[commentary:3]", {
      commentaryLookup: () => ({
        text: "The living entity is eternal.",
        authorName: "Prabhupada",
        addrLabel: "BG 2.20",
      }),
    })

    expect(out).toBe("> The living entity is eternal.\n>\n> _Prabhupada · BG 2.20_")
  })

  it("strips the marker when the client has no commentary lookup at all", () => {
    expect(convert("Before [commentary:3] after")).toBe("Before after")
  })

  it("strips the marker when the quote never arrived", () => {
    expect(convert("Before [commentary:3] after", { commentaryLookup: () => null })).toBe(
      "Before after"
    )
  })
})

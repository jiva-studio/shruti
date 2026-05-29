import { describe, expect, it } from "vitest"
import {
  extractFollowups,
  messageToMarkdown,
  parseChatMarkers,
  type CiteBodyLike,
  type VerseBodyLike,
} from "../chatMarkers.js"

/**
 * Marker grammar coverage. The parser is the bridge between LLM-emitted
 * inline markers and the bubble's component renderer — a regex regression
 * here silently turns markers into text tokens.
 */
describe("parseChatMarkers — action markers", () => {
  it("recognises share_pdf (snake_case)", () => {
    const tokens = parseChatMarkers("ok [action:share_pdf|id=abc12345]")
    const action = tokens.find((t) => t.kind === "action")
    expect(action).toBeTruthy()
    if (action && action.kind === "action") {
      expect(action.actionKind).toBe("share_pdf")
      expect(action.actionId).toBe("abc12345")
    }
  })

  it("rejects legacy kebab-case form (share-pdf)", () => {
    // Snake-only. Kebab-form markers from older persisted messages
    // parse to no action token (text only).
    const t1 = parseChatMarkers("[action:share-pdf|id=abc12345]")
    expect(t1.find((t) => t.kind === "action")).toBeUndefined()
  })

  it("ignores the removed create_playlist / save_note action kinds", () => {
    // create_playlist removed when "playlists become a stack of cards"
    // — old persisted messages parse to no action token (text only).
    // save_note removed earlier in favour of the CitationChip sheet.
    const t1 = parseChatMarkers("[action:create_playlist|id=abc12345]")
    expect(t1.find((t) => t.kind === "action")).toBeUndefined()
    const t2 = parseChatMarkers("[action:save_note|id=note_ABC_1]")
    expect(t2.find((t) => t.kind === "action")).toBeUndefined()
  })

  it("rejects malformed markers — wrong delimiter, spaces inside id", () => {
    const tokens1 = parseChatMarkers("[action:share_pdf id=abc12345]")
    const tokens2 = parseChatMarkers("[action:share_pdf|id=abc 12345]")
    expect(tokens1.find((t) => t.kind === "action")).toBeUndefined()
    expect(tokens2.find((t) => t.kind === "action")).toBeUndefined()
  })

  it("does not match when kind starts with a digit", () => {
    const tokens = parseChatMarkers("[action:42bad|id=abc12345]")
    expect(tokens.find((t) => t.kind === "action")).toBeUndefined()
  })

  it("finds multiple action markers in one message", () => {
    const tokens = parseChatMarkers(
      "first [action:share_pdf|id=aaa] then [action:enable_daily_reminder|id=bbb]"
    )
    const actions = tokens.filter((t) => t.kind === "action")
    expect(actions).toHaveLength(2)
  })
})

describe("parseChatMarkers — card grouping (playlists as card stacks)", () => {
  it("groups consecutive [card:X] markers into one cards token", () => {
    const tokens = parseChatMarkers(
      "Вот несколько лекций:\n[card:track_A]\n[card:track_B]\n[card:track_C]"
    )
    const cards = tokens.filter((t) => t.kind === "cards")
    expect(cards).toHaveLength(1)
    if (cards[0].kind === "cards") {
      expect(cards[0].trackIds).toEqual(["track_A", "track_B", "track_C"])
    }
  })

  it("emits a singleton cards token for an isolated [card:X]", () => {
    const tokens = parseChatMarkers("Прабхупада [card:track_X] упоминает")
    const cards = tokens.filter((t) => t.kind === "cards")
    expect(cards).toHaveLength(1)
    if (cards[0].kind === "cards") {
      expect(cards[0].trackIds).toEqual(["track_X"])
    }
  })

  it("splits when a non-blank text separates the cards", () => {
    // Cards interleaved with substantive prose stay separate groups.
    const tokens = parseChatMarkers("[card:track_A]\nProse paragraph.\n[card:track_B]")
    const cards = tokens.filter((t) => t.kind === "cards")
    expect(cards).toHaveLength(2)
  })
})

describe("parseChatMarkers — citation block spacing", () => {
  it("emits a cite token and collapses <br>/whitespace hugging it", () => {
    // `cite` renders as a block quote-card now, so surrounding line
    // breaks must be collapsed like the other block tokens — otherwise a
    // stray <br> stacks an empty line above/below the card.
    const tokens = parseChatMarkers("Before\n[cite:track_x@0-1000|cap]\nAfter")
    const cite = tokens.find((t) => t.kind === "cite")
    expect(cite?.kind).toBe("cite")
    for (const tk of tokens) {
      if (tk.kind !== "text") continue
      // No text token should be only whitespace/<br>, nor lead/trail with
      // a <br> run hugging the block.
      expect(tk.html.trim()).not.toBe("")
      expect(tk.html).not.toMatch(/^\s*<br\s*\/?>/i)
      expect(tk.html).not.toMatch(/<br\s*\/?>\s*$/i)
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

describe("parseChatMarkers — chapter-location markers", () => {
  it("parses [chapter:source/region|label]", () => {
    const tokens = parseChatMarkers(
      "Это в Седьмой песни: [chapter:source_NoY8sAlXF1IT/7|Песнь 7 «Наука о Боге»]"
    )
    const ch = tokens.find((t) => t.kind === "chapter")
    expect(ch).toBeTruthy()
    if (ch && ch.kind === "chapter") {
      expect(ch.sourceId).toBe("source_NoY8sAlXF1IT")
      expect(ch.regionToken).toBe("7")
      expect(ch.caption).toBe("Песнь 7 «Наука о Боге»")
    }
  })

  it("treats chapter label as optional", () => {
    const tokens = parseChatMarkers("[chapter:source_x/12]")
    const ch = tokens.find((t) => t.kind === "chapter")
    if (ch?.kind === "chapter") expect(ch.caption).toBe("")
  })

  it("strips the chapter marker from exported markdown", () => {
    const md = messageToMarkdown("Ответ. [chapter:source_x/7|Песнь 7]", {
      lang: "ru",
      verseLookup: () => null,
      citeLookup: () => null,
    })
    expect(md).toBe("Ответ.")
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

describe("parseChatMarkers — markdown header (## Label)", () => {
  /** Pull all text-token html out and join it — headers live INSIDE text
   *  tokens (no dedicated token kind), so assertions inspect the html. */
  const html = (input: string): string =>
    parseChatMarkers(input)
      .filter((t): t is Extract<typeof t, { kind: "text" }> => t.kind === "text")
      .map((t) => t.html)
      .join("")

  it("renders an ATX H2 as a decorated <h2 class='chat-header'>", () => {
    expect(html("## Природа кармы")).toContain('<h2 class="chat-header">Природа кармы</h2>')
  })

  it("inline-parses emphasis inside the header text", () => {
    expect(html("## Природа *кармы*")).toContain(
      '<h2 class="chat-header">Природа <em>кармы</em></h2>'
    )
  })

  it("extracts the header from surrounding prose without leaving <br> gaps", () => {
    const out = html("Вступление.\n\n## Заголовок\n\nТело абзаца.")
    expect(out).toContain('<h2 class="chat-header">Заголовок</h2>')
    expect(out).toContain("Вступление.")
    expect(out).toContain("Тело абзаца.")
    // No doubled break stacked directly on the block <h2>'s own margin.
    expect(out).not.toContain("<br><br><h2")
    expect(out).not.toContain("</h2><br><br>")
  })

  it("does NOT turn a bold line into a header (still inline <strong>)", () => {
    const out = html("**Природа кармы**")
    expect(out).toContain("<strong>Природа кармы</strong>")
    expect(out).not.toContain("<h2")
  })

  it("does NOT treat a setext underline (---) as a header, keeps the ---", () => {
    const out = html("Some text\n---\nMore text")
    expect(out).not.toContain("<h2")
    expect(out).toContain("---")
    expect(out).toContain("Some text")
    expect(out).toContain("More text")
  })

  it("leaves header markdown intact in the copy/share export", () => {
    const out = messageToMarkdown("## Заголовок\n\nТело.", {
      lang: "ru",
      verseLookup: () => null,
      citeLookup: () => null,
    })
    expect(out).toContain("## Заголовок")
  })
})

/**
 * Copy / Share export. `messageToMarkdown` is what we ship to the
 * clipboard and the platform share sheet, so a regression here breaks
 * user-visible behaviour silently — these cases pin the strip / keep
 * decisions for each marker kind.
 */
describe("messageToMarkdown", () => {
  const noVerses = () => null
  const noCites = () => null
  const ru = { lang: "ru" as const, verseLookup: noVerses, citeLookup: noCites }
  const en = { lang: "en" as const, verseLookup: noVerses, citeLookup: noCites }

  it("returns plain prose unchanged", () => {
    expect(messageToMarkdown("Hello **world**.", ru)).toBe("Hello **world**.")
  })

  it("strips audio cite markers and tidies the surrounding whitespace", () => {
    const out = messageToMarkdown("See here [cite:t1@1000-2000|caption] and there.", ru)
    expect(out).toContain("See here")
    expect(out).toContain("and there.")
    expect(out).not.toContain("[cite:")
  })

  it("strips card, outline, and action markers entirely", () => {
    const out = messageToMarkdown(
      "Top.\n\n[card:t1]\n[outline:t1]\n\n[action:share_pdf|id=abc12345]\n\nEnd.",
      ru
    )
    expect(out).not.toContain("[card:")
    expect(out).not.toContain("[outline:")
    expect(out).not.toContain("[action:")
    expect(out).toMatch(/^Top\./)
    expect(out.trim().endsWith("End.")).toBe(true)
  })

  it("strips followup chips", () => {
    const out = messageToMarkdown("Answer.\n\n[followup:Ask again?]", ru)
    expect(out.trim()).toBe("Answer.")
  })

  it("keeps markdown blockquotes (library document citations)", () => {
    const src = "Intro.\n\n> body line\n> *Attribution*\n\nOutro."
    expect(messageToMarkdown(src, ru)).toBe(src)
  })

  it("expands a verse marker into addr / sanskrit / iast / translation", () => {
    const body: VerseBodyLike = {
      addrLabel: "BG 2.14",
      sanskrit: "मात्रास्पर्शास्तु…",
      transliteration: "mātrā-sparśās tu…",
      translation: { en: "O son of Kunti…", ru: "О сын Кунти…" },
    }
    const opts = {
      lang: "ru" as const,
      verseLookup: (sid: string, tokens: string) =>
        sid === "source_abc" && tokens === "2.14" ? body : null,
      citeLookup: noCites,
    }
    const out = messageToMarkdown(
      "Verse below: [verse:source_abc/2.14|caption]\n\nthen prose.",
      opts
    )
    expect(out).toContain("**BG 2.14**")
    expect(out).toContain("mātrā-sparśās tu…")
    // Transliteration is intentionally NOT italic-wrapped — see
    // renderVerseMarkdown for the why (multi-line `*…*` is non-portable).
    expect(out).not.toMatch(/\*mātrā-sparśās tu…\*/)
    expect(out).toContain("О сын Кунти…")
    expect(out).not.toContain("[verse:")
  })

  it("collapses multi-blank-line runs inside sanskrit/iast/translation", () => {
    // Server occasionally ships verse text with `\n\n` between every
    // line (pāda-per-paragraph) — rendering that raw produces stacked
    // empty paragraphs when pasted into Telegram / Notes.
    const body: VerseBodyLike = {
      addrLabel: "ШБ 5.5.14",
      sanskrit: "кармāśayam line1\n\nline2\n\nline3\n\nline4",
      transliteration: "karmāśayam line1\n\nline2\n\nline3",
      translation: { ru: "Перевод\n\nвторая строка" },
    }
    const opts = { lang: "ru" as const, verseLookup: () => body, citeLookup: noCites }
    const out = messageToMarkdown("[verse:s/5.5.14]", opts)
    expect(out).not.toMatch(/line1\n\nline2/)
    expect(out).toMatch(/line1\nline2\nline3/)
    expect(out).toMatch(/Перевод\nвторая строка/)
  })

  it("falls back to English translation when requested locale is missing", () => {
    const body: VerseBodyLike = {
      addrLabel: "BG 1.1",
      sanskrit: "धर्मक्षेत्रे…",
      transliteration: "dharma-kṣetre…",
      translation: { en: "On the field of dharma…" },
    }
    const opts = {
      lang: "ru" as const,
      verseLookup: () => body,
      citeLookup: noCites,
    }
    const out = messageToMarkdown("[verse:source_x/1.1]", opts)
    expect(out).toContain("On the field of dharma…")
  })

  it("drops verse markers when the cache misses", () => {
    const out = messageToMarkdown("Mention: [verse:source_zzz/9.9] — but no body cached.", en)
    expect(out).not.toContain("[verse:")
    expect(out).toContain("Mention:")
    expect(out).toContain("but no body cached.")
  })

  it("expands a cite marker into a transcript blockquote + source line", () => {
    const body: CiteBodyLike = {
      text: "Krishna says the soul is eternal.",
      trackTitle: "BG 2.13 Lecture",
      authorName: "A. C. Bhaktivedanta Swami",
      reference: "BG 2.13",
      trackDate: "1972-05-03",
    }
    const opts = {
      lang: "ru" as const,
      verseLookup: noVerses,
      citeLookup: (trackId: string, startMs: number, endMs: number) =>
        trackId === "t1" && startMs === 1000 && endMs === 2000 ? body : null,
    }
    const out = messageToMarkdown("Listen: [cite:t1@1000-2000|the soul] then more.", opts)
    expect(out).not.toContain("[cite:")
    expect(out).toContain("> Krishna says the soul is eternal.")
    // Attribution joins title · author · reference · date, italic, inside
    // the blockquote.
    expect(out).toContain("> _BG 2.13 Lecture · A. C. Bhaktivedanta Swami · BG 2.13 · 1972-05-03_")
    expect(out).toContain("Listen:")
    expect(out).toContain("then more.")
  })

  it("falls back to the marker caption when no track meta resolved", () => {
    const opts = {
      lang: "en" as const,
      verseLookup: noVerses,
      citeLookup: () => ({ text: "Just the transcript." }),
    }
    const out = messageToMarkdown("[cite:t1@1000-2000|Duty vs Desire]", opts)
    expect(out).toContain("> Just the transcript.")
    expect(out).toContain("> _Duty vs Desire_")
  })

  it("drops cite markers when the transcript cache misses (legacy strip)", () => {
    const out = messageToMarkdown("See [cite:t9@10-20|cap] here — no transcript.", en)
    expect(out).not.toContain("[cite:")
    expect(out).not.toContain(">")
    expect(out).toContain("See")
    expect(out).toContain("here — no transcript.")
  })

  it("prefixes every transcript line with > and collapses blank runs", () => {
    const opts = {
      lang: "en" as const,
      verseLookup: noVerses,
      citeLookup: () => ({ text: "line one\n\nline two\n\n\nline three", trackTitle: "T" }),
    }
    const out = messageToMarkdown("[cite:t1@0-1]", opts)
    expect(out).toContain("> line one\n> line two\n> line three")
    expect(out).not.toMatch(/line one\n>\n> line two/) // blank-run collapse, not a quote break
  })

  it("collapses 3+ blank lines left by stripped markers down to 2", () => {
    const out = messageToMarkdown("A.\n\n[card:t1]\n\n[card:t2]\n\nB.", ru)
    // Trailing trim + collapse means the gap between A and B is exactly
    // one blank line.
    expect(out).toBe("A.\n\nB.")
  })

  it("returns an empty string for empty input", () => {
    expect(messageToMarkdown("", ru)).toBe("")
  })
})

import { describe, expect, it } from "vitest"
import {
  parseChapterPayload,
  parseCiteTranscriptPayload,
  parseCommentaryPayload,
  parseMediaPayload,
  parseOutlinePayload,
  parseVersePayload,
} from "../ssePayloadParsers.js"

describe("parseVersePayload", () => {
  it("reads a verse with every optional field the server sent", () => {
    expect(
      parseVersePayload({
        source_id: "bg",
        tokens: "2.13",
        addr_label: "BG 2.13",
        sanskrit: "देहिनोऽस्मिन्",
        transliteration: "dehino 'smin",
        transliteration_original: "дехино 'смин",
        lang: "ru",
        translation: { ru: "Воплощённый", en: "The embodied" },
        audio_url: "https://cdn/bg-2-13.mp3",
        mt: true,
      })
    ).toEqual({
      source_id: "bg",
      tokens: "2.13",
      addr_label: "BG 2.13",
      sanskrit: "देहिनोऽस्मिन्",
      transliteration: "dehino 'smin",
      transliteration_original: "дехино 'смин",
      lang: "ru",
      translation: { ru: "Воплощённый", en: "The embodied" },
      audio_url: "https://cdn/bg-2-13.mp3",
      mt: true,
    })
  })

  it("omits the optional fields the server left out", () => {
    const verse = parseVersePayload({ source_id: "bg", tokens: "2.13" })
    expect(verse).toEqual({
      source_id: "bg",
      tokens: "2.13",
      addr_label: "",
      sanskrit: "",
      transliteration: "",
      translation: {},
    })
  })

  it("drops a verse with no address", () => {
    expect(parseVersePayload({ tokens: "2.13" })).toBeNull()
    expect(parseVersePayload({ source_id: "bg" })).toBeNull()
  })

  it("keeps only the string translations", () => {
    const verse = parseVersePayload({
      source_id: "bg",
      tokens: "2.13",
      translation: { en: "text", ru: "", de: 42 },
    })
    expect(verse?.translation).toEqual({ en: "text" })
  })

  it("has no translations when the field is an array", () => {
    expect(
      parseVersePayload({ source_id: "bg", tokens: "2.13", translation: ["x"] })?.translation
    ).toEqual({})
  })

  it("marks a machine translation only on an explicit true", () => {
    expect(parseVersePayload({ source_id: "bg", tokens: "1.1", mt: "yes" })).not.toHaveProperty(
      "mt"
    )
  })
})

describe("parseCiteTranscriptPayload", () => {
  it("reads a cited span", () => {
    expect(
      parseCiteTranscriptPayload({
        track_id: "t1",
        start_ms: 1000,
        end_ms: 5000,
        text: "  a quote  ",
      })
    ).toEqual({ track_id: "t1", start_ms: 1000, end_ms: 5000, text: "a quote" })
  })

  it("drops a citation with no span", () => {
    expect(parseCiteTranscriptPayload({ track_id: "t1", end_ms: 5000, text: "x" })).toBeNull()
    expect(parseCiteTranscriptPayload({ track_id: "t1", start_ms: 0, text: "x" })).toBeNull()
  })

  it("drops a citation whose span arrived as strings", () => {
    expect(
      parseCiteTranscriptPayload({ track_id: "t1", start_ms: "0", end_ms: "500", text: "x" })
    ).toBeNull()
  })

  it("keeps the untranslated text only on a machine-translated citation", () => {
    expect(
      parseCiteTranscriptPayload({
        track_id: "t1",
        start_ms: 0,
        end_ms: 1,
        text: "translated",
        text_original: "original",
      })
    ).not.toHaveProperty("text_original")
  })
})

describe("parseCommentaryPayload", () => {
  it("reads a commentary with its defaults", () => {
    expect(parseCommentaryPayload({ ref: 1, text: " purport " })).toEqual({
      ref: 1,
      text: "purport",
      author_name: "",
      addr_label: "",
      kind: "commentary",
    })
  })

  it("keeps the server's kind", () => {
    expect(parseCommentaryPayload({ ref: 1, text: "x", kind: "letter" })?.kind).toBe("letter")
  })

  it("drops a commentary with no ref or no text", () => {
    expect(parseCommentaryPayload({ text: "x" })).toBeNull()
    expect(parseCommentaryPayload({ ref: 1, text: "   " })).toBeNull()
  })

  it("carries the original alongside a machine-translated commentary", () => {
    expect(
      parseCommentaryPayload({ ref: 1, text: "перевод", mt: true, text_original: "source" })
    ).toMatchObject({ mt: true, text_original: "source" })
  })
})

describe("parseChapterPayload", () => {
  it("reads the chapter rows", () => {
    expect(
      parseChapterPayload({
        source_id: "sb",
        region_token: "5",
        region_label: "Canto 5",
        chapters: [{ tokens: "5.1", title: "First" }, { title: "No tokens" }, null],
      })
    ).toEqual({
      source_id: "sb",
      region_token: "5",
      region_label: "Canto 5",
      chapters: [{ tokens: "5.1", title: "First" }],
    })
  })

  it("drops a chapter list with no source or a non-string region", () => {
    expect(parseChapterPayload({ region_token: "5", chapters: [{ tokens: "5.1" }] })).toBeNull()
    expect(parseChapterPayload({ source_id: "sb", chapters: [{ tokens: "5.1" }] })).toBeNull()
  })

  it("drops a chapter list whose chapters field is not a list", () => {
    expect(parseChapterPayload({ source_id: "sb", region_token: "", chapters: "1" })).toBeNull()
  })
})

describe("parseMediaPayload", () => {
  it("reads a clip with its attribution", () => {
    expect(
      parseMediaPayload({
        id: "m1",
        url: "https://cdn/clip.mp4",
        type: "video",
        title: "A clip",
        text: "what happens",
        speaker: "A Speaker",
        date: "2024-01-02",
      })
    ).toEqual({
      id: "m1",
      url: "https://cdn/clip.mp4",
      type: "video",
      title: "A clip",
      text: "what happens",
      speaker: "A Speaker",
      date: "2024-01-02",
    })
  })

  it("reads an audio clip", () => {
    expect(parseMediaPayload({ id: "m1", url: "u", type: "audio" })?.type).toBe("audio")
  })

  it("drops a clip with no id, no url or an unknown type", () => {
    expect(parseMediaPayload({ url: "u", type: "audio" })).toBeNull()
    expect(parseMediaPayload({ id: "m1", type: "audio" })).toBeNull()
    expect(parseMediaPayload({ id: "m1", url: "u", type: "pdf" })).toBeNull()
  })
})

describe("parseOutlinePayload", () => {
  it("reads the outline items", () => {
    expect(
      parseOutlinePayload({
        track_id: "t1",
        items: [
          { start_ms: 0, title: " Intro " },
          { start_ms: 1000, title: "Body" },
        ],
      })
    ).toEqual({
      trackId: "t1",
      items: [
        { startMs: 0, title: "Intro" },
        { startMs: 1000, title: "Body" },
      ],
    })
  })

  it("drops an item with no title or a non-numeric start", () => {
    expect(
      parseOutlinePayload({
        track_id: "t1",
        items: [
          { start_ms: 0, title: "  " },
          { start_ms: "1000", title: "Body" },
          { start_ms: 2000, title: "Kept" },
        ],
      })
    ).toEqual({ trackId: "t1", items: [{ startMs: 2000, title: "Kept" }] })
  })

  it("drops an outline with no track or no usable item", () => {
    expect(parseOutlinePayload({ items: [{ start_ms: 0, title: "Intro" }] })).toBeNull()
    expect(parseOutlinePayload({ track_id: "t1", items: [] })).toBeNull()
    expect(parseOutlinePayload({ track_id: "t1", items: [{ title: "no start" }] })).toBeNull()
  })
})

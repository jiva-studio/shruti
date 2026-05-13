import { describe, expect, it } from "vitest"
import type { LanguageCode, SourceId, TrackId } from "@lib/domain/core.js"
import type { Reference } from "@lib/domain/reference.js"
import type { Source } from "@lib/domain/source.js"
import type { Transcript, TranscriptBlock } from "@lib/domain/transcript.js"
import { buildTranscriptViewData } from "../buildTranscriptViewData.js"

function sentence(start: number, end: number, text: string): TranscriptBlock {
  return { type: "sentence", start, end, text }
}

function makeTranscript(blocks: TranscriptBlock[]): Transcript {
  return {
    trackId: "t1" as TrackId,
    language: "ru" as LanguageCode,
    version: 1,
    blocks,
  }
}

const EN: LanguageCode = "en" as LanguageCode
const RU: LanguageCode = "ru" as LanguageCode

function makeSources(): ReadonlyMap<string, Source> {
  return new Map<string, Source>([
    [
      "bg",
      {
        id: "bg" as SourceId,
        names: new Map([
          [EN, { fullName: "Bhagavad-gītā", shortName: "BG" }],
          [RU, { fullName: "Бхагавад-гӣта̄", shortName: "БГ" }],
        ]),
      },
    ],
    [
      // Short-name only — no fullName entry (synthetic edge case to drive
      // the full → short fallback path).
      "sb-short-only",
      {
        id: "sb-short-only" as SourceId,
        names: new Map([[EN, { fullName: "", shortName: "SB" }]]),
      },
    ],
  ])
}

const ref = (sourceId: string, ...tokens: string[]): Reference =>
  ({ sourceId: sourceId as Reference["sourceId"], tokens }) as Reference

describe("buildTranscriptViewData — paragraph chunking", () => {
  it("server-emitted paragraph block forces a new group", () => {
    const t = makeTranscript([
      sentence(0, 1000, "первый"),
      { type: "paragraph", start: 1000, end: 1500 },
      sentence(1500, 2500, "второй"),
    ])
    const groups = buildTranscriptViewData(t, { paragraphChars: 9999 })
    expect(groups).toHaveLength(2)
    expect(groups[0].blocks).toHaveLength(1)
    expect(groups[1].blocks).toHaveLength(1)
  })

  it("char-count threshold breaks long sentences into multiple groups", () => {
    // Each sentence is 100 chars; threshold 250 → adding a 3rd sentence
    // (200+100=300 > 250) starts a new paragraph BEFORE the push, so
    // each paragraph holds 2 sentences (200 chars).
    const long = "x".repeat(100)
    const blocks: TranscriptBlock[] = []
    for (let i = 0; i < 12; i++) {
      blocks.push(sentence(i * 1000, i * 1000 + 800, long))
    }
    const groups = buildTranscriptViewData(makeTranscript(blocks), { paragraphChars: 250 })
    // 12 sentences ÷ 2 per group = 6 groups
    expect(groups).toHaveLength(6)
    expect(groups[0].blocks).toHaveLength(2)
    expect(groups[5].blocks).toHaveLength(2)
  })

  it("paragraphChars=0 disables auto-break (single group when no markers)", () => {
    const blocks: TranscriptBlock[] = []
    for (let i = 0; i < 5; i++) {
      blocks.push(sentence(i * 1000, i * 1000 + 800, "abc"))
    }
    const groups = buildTranscriptViewData(makeTranscript(blocks), { paragraphChars: 0 })
    expect(groups).toHaveLength(1)
    expect(groups[0].blocks).toHaveLength(5)
  })

  it("server-marker and char-threshold cooperate", () => {
    // Two short sentences (50 chars each) → server paragraph → two more.
    // Char-threshold 9999 means only the marker forces the split.
    const t = makeTranscript([
      sentence(0, 1000, "a".repeat(50)),
      sentence(1000, 2000, "b".repeat(50)),
      { type: "paragraph", start: 2000, end: 2500 },
      sentence(2500, 3500, "c".repeat(50)),
      sentence(3500, 4500, "d".repeat(50)),
    ])
    const groups = buildTranscriptViewData(t, { paragraphChars: 9999 })
    expect(groups).toHaveLength(2)
    expect(groups[0].blocks).toHaveLength(2)
    expect(groups[1].blocks).toHaveLength(2)
  })

  it("returns empty array on null transcript", () => {
    expect(buildTranscriptViewData(null, { paragraphChars: 100 })).toEqual([])
  })
})

describe("buildTranscriptViewData — reference source-name resolution", () => {
  const sources = makeSources()

  it("falls back to raw sourceId when no dictionary is provided", () => {
    const t = makeTranscript([
      {
        type: "sentence",
        start: 0,
        end: 1000,
        text: "verse mention",
        reference: ref("bg", "2", "13"),
      },
    ])
    const groups = buildTranscriptViewData(t, { paragraphChars: 9999 })
    const block = groups[0].blocks[0].block
    expect(block.type).toBe("sentence")
    if (block.type !== "sentence") throw new Error("type guard")
    expect(block.reference).toBe("bg 2.13")
  })

  it("sentence-block references use the localised SHORT name", () => {
    const t = makeTranscript([
      {
        type: "sentence",
        start: 0,
        end: 1000,
        text: "verse mention",
        reference: ref("bg", "2", "13"),
      },
    ])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      sourcesById: sources,
      lang: EN,
    })
    const block = groups[0].blocks[0].block
    if (block.type !== "sentence") throw new Error("type guard")
    expect(block.reference).toBe("BG 2.13")
  })

  it("multi-line verse:text uses the localised FULL name", () => {
    const t = makeTranscript([
      {
        type: "verse:text",
        start: 0,
        end: 1000,
        text: ["dharma-kṣetre kuru-kṣetre", "samavetā yuyutsavaḥ"],
        reference: ref("bg", "1", "1"),
      },
    ])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      sourcesById: sources,
      lang: EN,
    })
    const block = groups[0].blocks[0].block
    if (block.type !== "verse:text") throw new Error("type guard")
    expect(block.reference).toBe("Bhagavad-gītā 1.1")
  })

  it("single-line verse:text (inline) uses the localised SHORT name", () => {
    const t = makeTranscript([
      {
        type: "verse:text",
        start: 0,
        end: 1000,
        text: ["one line only"],
        reference: ref("bg", "2", "13"),
      },
    ])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      sourcesById: sources,
      lang: EN,
    })
    const block = groups[0].blocks[0].block
    if (block.type !== "verse:text") throw new Error("type guard")
    expect(block.reference).toBe("BG 2.13")
  })

  it("picks up the active language for localised names", () => {
    const t = makeTranscript([
      {
        type: "verse:text",
        start: 0,
        end: 1000,
        text: ["строка 1", "строка 2"],
        reference: ref("bg", "2", "13"),
      },
    ])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      sourcesById: sources,
      lang: RU,
    })
    const block = groups[0].blocks[0].block
    if (block.type !== "verse:text") throw new Error("type guard")
    expect(block.reference).toBe("Бхагавад-гӣта̄ 2.13")
  })

  it("multi-line verse:text falls back full → short when fullName is empty", () => {
    const t = makeTranscript([
      {
        type: "verse:text",
        start: 0,
        end: 1000,
        text: ["a", "b"],
        reference: ref("sb-short-only", "1", "1", "1"),
      },
    ])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      sourcesById: sources,
      lang: EN,
    })
    const block = groups[0].blocks[0].block
    if (block.type !== "verse:text") throw new Error("type guard")
    expect(block.reference).toBe("SB 1.1.1")
  })

  it("falls back to raw sourceId when source is missing from the dictionary", () => {
    const t = makeTranscript([
      {
        type: "verse:text",
        start: 0,
        end: 1000,
        text: ["a", "b"],
        reference: ref("ghost", "1", "1"),
      },
    ])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      sourcesById: sources,
      lang: EN,
    })
    const block = groups[0].blocks[0].block
    if (block.type !== "verse:text") throw new Error("type guard")
    expect(block.reference).toBe("ghost 1.1")
  })
})

describe("buildTranscriptViewData — saved-note overlay", () => {
  it("marks blocks that overlap any saved note range as bookmarked", () => {
    const t = makeTranscript([
      sentence(0, 999, "one"),
      sentence(1000, 2000, "two"),
      sentence(2000, 3000, "three"),
      sentence(3001, 4000, "four"),
    ])
    // Both blocks and note ranges are in milliseconds.
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      notes: [{ timeStart: 1000, timeEnd: 2500 }],
    })
    const blocks = groups.flatMap((g) => g.blocks)
    expect(blocks.map((b) => b.bookmarked)).toEqual([false, true, true, false])
  })

  it("renders bookmarked: false for every block when notes is omitted", () => {
    const t = makeTranscript([sentence(0, 1000, "x"), sentence(1000, 2000, "y")])
    const groups = buildTranscriptViewData(t, { paragraphChars: 9999 })
    const blocks = groups.flatMap((g) => g.blocks)
    expect(blocks.every((b) => b.bookmarked === false)).toBe(true)
  })

  it("treats touching boundaries as overlap (inclusive)", () => {
    const t = makeTranscript([sentence(2000, 3000, "edge")])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      notes: [{ timeStart: 0, timeEnd: 2000 }],
    })
    expect(groups[0]!.blocks[0]!.bookmarked).toBe(true)
  })
})

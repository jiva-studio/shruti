import { describe, expect, it } from "vitest"
import type { LanguageCode, NoteId, SourceId, TrackId } from "@lib/domain/core.js"
import type { Reference } from "@lib/domain/reference.js"
import type { Source } from "@lib/domain/source.js"
import type { Transcript, TranscriptBlock } from "@lib/domain/transcript.js"
import {
  buildTranscriptViewData,
  buildMergedTranscriptViewData,
  multiSpeakerLanguages,
} from "../buildTranscriptViewData.js"

function sentence(start: number, end: number, text: string): TranscriptBlock {
  return { type: "sentence", start, end, text }
}

function spoken(start: number, end: number, text: string, speaker?: string): TranscriptBlock {
  return { type: "sentence", start, end, text, speaker }
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

function transcriptIn(language: LanguageCode, blocks: TranscriptBlock[]): Transcript {
  return { trackId: "t1" as TrackId, language, version: 1, blocks }
}

describe("buildMergedTranscriptViewData — multi-language interleave", () => {
  // A lecturer(en)+translator(ru) recording: sentences alternate in time.
  const en = transcriptIn(EN, [
    sentence(0, 900, "Forgiveness is important."),
    sentence(2000, 2900, "One should never desire to be the cause."),
  ])
  const ru = transcriptIn(RU, [
    sentence(1000, 1900, "Прощение важно."),
    sentence(3000, 3900, "Не следует желать быть причиной."),
  ])

  it("orders every language's blocks by time, each keeping its own language", () => {
    const groups = buildMergedTranscriptViewData(
      [
        { language: EN, transcript: en },
        { language: RU, transcript: ru },
      ],
      { paragraphChars: 9999, breakOnLanguageChange: true }
    )
    const flat = groups.flatMap((g) => g.blocks)
    expect(flat.map((b) => b.block.start)).toEqual([0, 1000, 2000, 3000])
    expect(flat.map((b) => b.language)).toEqual([EN, RU, EN, RU])
  })

  it("never mixes languages in one paragraph when breakOnLanguageChange is set", () => {
    const groups = buildMergedTranscriptViewData(
      [
        { language: EN, transcript: en },
        { language: RU, transcript: ru },
      ],
      { paragraphChars: 9999, breakOnLanguageChange: true }
    )
    // Each alternation forces a fresh group → every group is single-language.
    for (const g of groups) {
      const langs = new Set(g.blocks.map((b) => b.language))
      expect(langs.size).toBe(1)
    }
  })

  it("allows a paragraph to span languages when breakOnLanguageChange is off", () => {
    // High char threshold + no language break → all four alternating blocks
    // accumulate into ONE mixed-language group.
    const groups = buildMergedTranscriptViewData(
      [
        { language: EN, transcript: en },
        { language: RU, transcript: ru },
      ],
      { paragraphChars: 9999, breakOnLanguageChange: false }
    )
    expect(groups).toHaveLength(1)
    expect(new Set(groups[0].blocks.map((b) => b.language))).toEqual(new Set([EN, RU]))
  })

  it("returns [] for no transcripts", () => {
    expect(buildMergedTranscriptViewData([], { paragraphChars: 100 })).toEqual([])
  })

  it("sentence-paired: aligned translations pair into one stacked group per sentence", () => {
    const enA = transcriptIn(EN, [sentence(0, 1000, "Hello"), sentence(1000, 2000, "World")])
    const ruA = transcriptIn(RU, [sentence(0, 1000, "Привет"), sentence(1000, 2000, "Мир")])
    const groups = buildMergedTranscriptViewData(
      [
        { language: EN, transcript: enA },
        { language: RU, transcript: ruA },
      ],
      { paragraphChars: 9999, sentencePaired: true }
    )
    expect(groups).toHaveLength(2) // one group per sentence
    for (const g of groups) {
      expect(g.paired).toBe(true)
      // Source (the transcripts[] order → EN first) then the translation.
      expect(g.blocks.map((b) => b.language)).toEqual([EN, RU])
    }
    const texts = groups[0].blocks.map((b) => (b.block.type === "sentence" ? b.block.text : ""))
    expect(texts).toEqual(["Hello", "Привет"])
  })
})

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
    // No notes → no ids attached.
    expect(blocks.every((b) => b.noteIds.length === 0)).toBe(true)
  })

  it("treats touching boundaries as disjoint (half-open)", () => {
    const t = makeTranscript([sentence(2000, 3000, "edge")])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      notes: [{ timeStart: 0, timeEnd: 2000 }],
    })
    expect(groups[0]!.blocks[0]!.bookmarked).toBe(false)
  })

  /**
   * Issue #1731. Sentence blocks in this corpus are commonly contiguous
   * (`end_i === start_{i+1}`), so an inclusive-on-both-ends overlap test made a
   * one-sentence bookmark underline its two neighbours the moment it was saved
   * — and bled `noteIds` onto them, so tapping either opened that note's Delete
   * popover. Real timings from the issue.
   */
  it("marks ONLY the noted sentence when its neighbours are exactly contiguous", () => {
    const t = makeTranscript([
      sentence(560, 19440, "before"),
      sentence(19440, 30880, "noted"),
      sentence(30880, 64959, "after"),
    ])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      notes: [{ id: "note-a" as NoteId, timeStart: 19440, timeEnd: 30880 }],
    })
    const blocks = groups.flatMap((g) => g.blocks)
    expect(blocks.map((b) => b.bookmarked)).toEqual([false, true, false])
    expect(blocks.map((b) => Array.from(b.noteIds))).toEqual([[], ["note-a"], []])
  })

  /**
   * A zero-length note range IS representable: `validateNoteFields` only
   * rejects `timeEnd < timeStart`, and a bookmark taken on a zero-length block
   * (verse chips carry `start === end`) produces exactly one. A point range
   * marks the block that contains the instant — and nothing else.
   */
  it("resolves a zero-length note range to the block that contains the instant", () => {
    const t = makeTranscript([
      sentence(560, 19440, "before"),
      sentence(19440, 30880, "noted"),
      sentence(30880, 64959, "after"),
    ])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      notes: [{ id: "note-a" as NoteId, timeStart: 25000, timeEnd: 25000 }],
    })
    const blocks = groups.flatMap((g) => g.blocks)
    expect(blocks.map((b) => b.bookmarked)).toEqual([false, true, false])
  })

  /** Zero-length BLOCKS (verse chips) still take the underline of a note that
   *  covers their instant — a half-open test alone would never match them. */
  it("keeps a zero-length block bookmarked when a note covers its instant", () => {
    const t = makeTranscript([
      { type: "verse:translation", start: 10840, end: 10840, text: "verse" },
      sentence(19440, 30880, "noted"),
    ])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      notes: [{ id: "note-a" as NoteId, timeStart: 5000, timeEnd: 19440 }],
    })
    const blocks = groups.flatMap((g) => g.blocks)
    expect(blocks.map((b) => b.bookmarked)).toEqual([true, false])
  })

  it("collects overlapping note ids onto each block's `noteIds`", () => {
    const t = makeTranscript([
      sentence(0, 999, "one"),
      sentence(1000, 2000, "two"),
      sentence(2000, 3000, "three"),
      sentence(3001, 4000, "four"),
    ])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      notes: [
        { id: "note-a" as NoteId, timeStart: 1000, timeEnd: 2500 },
        { id: "note-b" as NoteId, timeStart: 3001, timeEnd: 4000 },
      ],
    })
    const blocks = groups.flatMap((g) => g.blocks)
    expect(blocks.map((b) => Array.from(b.noteIds))).toEqual([
      [],
      ["note-a"],
      ["note-a"],
      ["note-b"],
    ])
  })

  it("multiple overlapping notes append all their ids onto the same block", () => {
    const t = makeTranscript([sentence(0, 2000, "covered twice")])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      notes: [
        { id: "note-a" as NoteId, timeStart: 0, timeEnd: 1000 },
        { id: "note-b" as NoteId, timeStart: 500, timeEnd: 1500 },
      ],
    })
    const block = groups[0]!.blocks[0]!
    expect(block.bookmarked).toBe(true)
    expect(Array.from(block.noteIds)).toEqual(["note-a", "note-b"])
  })

  it("notes without an `id` (preview mode) still set `bookmarked` but leave `noteIds` empty", () => {
    const t = makeTranscript([sentence(0, 1000, "preview")])
    const groups = buildTranscriptViewData(t, {
      paragraphChars: 9999,
      notes: [{ timeStart: 0, timeEnd: 500 }],
    })
    const block = groups[0]!.blocks[0]!
    expect(block.bookmarked).toBe(true)
    expect(block.noteIds).toEqual([])
  })
})

/**
 * Which transcripts are dialogues. The reader hangs its dialogue affordances —
 * the per-line speaker icon and the speaker-change dash + line break — off this,
 * having previously hung them off the LANGUAGE count (issue #412).
 */
describe("multiSpeakerLanguages", () => {
  it("reports nothing for a transcript with no speaker info at all", () => {
    const groups = buildTranscriptViewData(
      makeTranscript([sentence(0, 1000, "A"), sentence(1000, 2000, "B")]),
      { paragraphChars: 9999 }
    )
    expect(multiSpeakerLanguages(groups)).toEqual(new Set())
  })

  it("reports nothing for a monologue — one speaker is not a dialogue", () => {
    const groups = buildTranscriptViewData(
      makeTranscript([spoken(0, 1000, "A", "Prabhupāda"), spoken(1000, 2000, "B", "Prabhupāda")]),
      { paragraphChars: 9999 }
    )
    expect(multiSpeakerLanguages(groups)).toEqual(new Set())
  })

  it("ignores blocks with no speaker beside a single named one", () => {
    const groups = buildTranscriptViewData(
      makeTranscript([spoken(0, 1000, "A", "Prabhupāda"), sentence(1000, 2000, "B")]),
      { paragraphChars: 9999 }
    )
    expect(multiSpeakerLanguages(groups)).toEqual(new Set())
  })

  it("reports the language once two distinct speakers appear", () => {
    const groups = buildTranscriptViewData(
      makeTranscript([spoken(0, 1000, "A", "Prabhupāda"), spoken(1000, 2000, "B", "Guest")]),
      { paragraphChars: 9999 }
    )
    // `makeTranscript` builds a ru transcript.
    expect(multiSpeakerLanguages(groups)).toEqual(new Set([RU]))
  })

  it("still reports a dialogue split across paragraphs", () => {
    // A paragraph break resets the grouper's running speaker, so the count has
    // to survive the flush rather than be read per group.
    const groups = buildTranscriptViewData(
      makeTranscript([
        spoken(0, 1000, "A", "Prabhupāda"),
        { type: "paragraph", start: 1000, end: 1000 } as TranscriptBlock,
        spoken(1000, 2000, "B", "Guest"),
      ]),
      { paragraphChars: 9999 }
    )
    expect(groups.length).toBeGreaterThan(1)
    expect(multiSpeakerLanguages(groups)).toEqual(new Set([RU]))
  })

  it("evaluates each language on its own — a monologue stays clean beside a dialogue", () => {
    const groups = buildMergedTranscriptViewData(
      [
        {
          language: EN,
          transcript: transcriptIn(EN, [
            spoken(0, 900, "One", "Prabhupāda"),
            spoken(2000, 2900, "Two", "Prabhupāda"),
          ]),
        },
        {
          language: RU,
          transcript: transcriptIn(RU, [
            spoken(1000, 1900, "Раз", "Прабхупада"),
            spoken(3000, 3900, "Два", "Гость"),
          ]),
        },
      ],
      { paragraphChars: 9999, breakOnLanguageChange: true }
    )
    expect(multiSpeakerLanguages(groups)).toEqual(new Set([RU]))
  })

  it("returns nothing for an empty view", () => {
    expect(multiSpeakerLanguages([])).toEqual(new Set())
  })
})

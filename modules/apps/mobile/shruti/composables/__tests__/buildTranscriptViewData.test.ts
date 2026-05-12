import { describe, expect, it } from "vitest"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
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
    // Each sentence is 100 chars; threshold 250 → group flushes after 3 sentences.
    const long = "x".repeat(100)
    const blocks: TranscriptBlock[] = []
    for (let i = 0; i < 12; i++) {
      blocks.push(sentence(i * 1000, i * 1000 + 800, long))
    }
    const groups = buildTranscriptViewData(makeTranscript(blocks), { paragraphChars: 250 })
    // 12 sentences ÷ 3 per group = 4 groups
    expect(groups).toHaveLength(4)
    expect(groups[0].blocks).toHaveLength(3)
    expect(groups[3].blocks).toHaveLength(3)
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

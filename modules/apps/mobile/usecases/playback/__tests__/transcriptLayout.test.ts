import { describe, expect, it } from "vitest"
import type { LanguageCode } from "@lib/domain/core.js"
import type { TranscriptBlock } from "@lib/domain/transcript.js"
import { createChapterCursor, startsNewParagraph } from "../transcriptLayout.js"

const sentence = (text: string): TranscriptBlock =>
  ({ type: "sentence", start: 0, end: 1000, text }) as TranscriptBlock

const EN = "en" as LanguageCode
const RU = "ru" as LanguageCode

const state = (over: Partial<Parameters<typeof startsNewParagraph>[2]> = {}) => ({
  hasCurrent: true,
  charsAccum: 0,
  lastLanguage: EN,
  blockLanguage: EN,
  ...over,
})

describe("startsNewParagraph", () => {
  it("never breaks on an empty paragraph", () => {
    expect(
      startsNewParagraph(
        sentence("x".repeat(500)),
        { paragraphChars: 10 },
        state({ hasCurrent: false })
      )
    ).toBe(false)
  })

  it("breaks when the sentence would cross the character threshold", () => {
    const block = sentence("x".repeat(20))
    expect(startsNewParagraph(block, { paragraphChars: 25 }, state({ charsAccum: 10 }))).toBe(true)
    expect(startsNewParagraph(block, { paragraphChars: 25 }, state({ charsAccum: 4 }))).toBe(false)
  })

  it("ignores the threshold when it is disabled", () => {
    expect(startsNewParagraph(sentence("xxx"), { paragraphChars: 0 }, state())).toBe(false)
  })

  it("breaks on a language change only when asked", () => {
    const block = sentence("x")
    const over = state({ blockLanguage: RU })
    expect(startsNewParagraph(block, { paragraphChars: 100 }, over)).toBe(false)
    expect(
      startsNewParagraph(block, { paragraphChars: 100, breakOnLanguageChange: true }, over)
    ).toBe(true)
  })
})

describe("createChapterCursor", () => {
  const chapters = [
    { title: "Second", startMs: 2000, endMs: 3000 },
    { title: "First", startMs: 1000, endMs: 2000 },
    { title: "Broken", startMs: Number.NaN, endMs: 0 },
  ]

  it("returns the chapter a block opens, in time order", () => {
    const cursor = createChapterCursor(chapters)
    expect(cursor.take(0)).toBeUndefined()
    expect(cursor.take(1000)?.title).toBe("First")
    expect(cursor.take(1500)).toBeUndefined()
    expect(cursor.take(2500)?.title).toBe("Second")
  })

  it("collapses several chapters before the same block to the last one", () => {
    const cursor = createChapterCursor(chapters)
    expect(cursor.take(9000)?.title).toBe("Second")
    expect(cursor.remaining()).toEqual([])
  })

  it("reports the chapters no block ever reached", () => {
    const cursor = createChapterCursor(chapters)
    cursor.take(1000)
    expect(cursor.remaining().map((c) => c.title)).toEqual(["Second"])
  })

  it("tolerates a track with no outline", () => {
    const cursor = createChapterCursor(undefined)
    expect(cursor.take(1000)).toBeUndefined()
    expect(cursor.remaining()).toEqual([])
  })
})

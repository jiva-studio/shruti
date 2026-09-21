import { describe, expect, it } from "vitest"
import type { TranscriptBlock } from "@lib/domain/transcript.js"
import { quoteTranscriptSpan } from "../quoteTranscriptSpan.js"

function sentence(start: number, end: number, text: string): TranscriptBlock {
  return { type: "sentence", start, end, text } as TranscriptBlock
}

describe("quoteTranscriptSpan", () => {
  const blocks = [
    sentence(0, 1000, "Before."),
    sentence(1000, 2000, "First."),
    sentence(2000, 3000, "Second."),
    sentence(3000, 4000, "After."),
  ]

  it("joins every sentence overlapping the span", () => {
    expect(quoteTranscriptSpan(blocks, 1200, 2500)).toBe("First. Second.")
  })

  it("treats the span as closed at both ends", () => {
    expect(quoteTranscriptSpan(blocks, 1000, 1000)).toBe("Before. First.")
  })

  it("has nothing to quote outside the transcript", () => {
    expect(quoteTranscriptSpan(blocks, 9000, 9500)).toBe("")
    expect(quoteTranscriptSpan([], 0, 1000)).toBe("")
  })

  it("passes over a block that is not a sentence", () => {
    const withHeading = [
      { type: "heading", start: 1000, end: 1100, text: "Chapter" } as unknown as TranscriptBlock,
      sentence(1000, 2000, "First."),
    ]
    expect(quoteTranscriptSpan(withHeading, 1000, 2000)).toBe("First.")
  })

  it("drops a blank sentence rather than padding the quote with spaces", () => {
    const withBlank = [sentence(1000, 1500, "   "), sentence(1500, 2000, "First.")]
    expect(quoteTranscriptSpan(withBlank, 1000, 2000)).toBe("First.")
  })
})

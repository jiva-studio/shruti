import { describe, expect, it } from "vitest"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Transcript, TranscriptBlock } from "@lib/domain/transcript.js"
import { transcriptToText } from "../transcriptToText.js"

const transcript = (blocks: TranscriptBlock[]): Transcript => ({
  trackId: "t1" as TrackId,
  language: "en" as LanguageCode,
  version: 1,
  blocks,
})

const sentence = (text: string): TranscriptBlock => ({ type: "sentence", start: 0, end: 1, text })
const paragraph = (): TranscriptBlock =>
  ({ type: "paragraph", start: 0, end: 0 }) as TranscriptBlock

describe("transcriptToText", () => {
  it("puts one sentence per line", () => {
    expect(transcriptToText(transcript([sentence("One."), sentence("Two.")]))).toBe("One.\nTwo.")
  })

  it("turns a paragraph marker into a blank line", () => {
    const text = transcriptToText(transcript([sentence("One."), paragraph(), sentence("Two.")]))
    expect(text).toBe("One.\n\nTwo.")
  })

  it("never opens with a blank line or repeats one", () => {
    const text = transcriptToText(
      transcript([paragraph(), sentence("One."), paragraph(), paragraph(), sentence("Two.")])
    )
    expect(text).toBe("One.\n\nTwo.")
  })

  it("joins a verse's lines and keeps its translation", () => {
    const text = transcriptToText(
      transcript([
        { type: "verse:text", start: 0, end: 1, text: ["line one", "line two"] } as TranscriptBlock,
        { type: "verse:translation", start: 0, end: 1, text: "meaning" } as TranscriptBlock,
      ])
    )
    expect(text).toBe("line one line two\nmeaning")
  })

  it("drops empty and whitespace-only blocks", () => {
    expect(transcriptToText(transcript([sentence("   "), sentence("Kept.")]))).toBe("Kept.")
  })

  it("is empty for a transcript with nothing to say", () => {
    expect(transcriptToText(transcript([]))).toBe("")
  })
})

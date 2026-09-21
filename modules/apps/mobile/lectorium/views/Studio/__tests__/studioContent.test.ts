import { describe, expect, it } from "vitest"
import type { NoteMeta } from "@lib/domain/note.js"
import type { TranscriptBlock } from "@lib/domain/transcript.js"
import {
  joinOverlappingSentences,
  nextStudioMeta,
  readStudioMeta,
  studioShareRange,
} from "../studioContent.js"

const blocks = [
  { type: "sentence", start: 0, end: 1000, text: "First." },
  { type: "sentence", start: 1000, end: 2000, text: "  Second.  " },
  { type: "sentence", start: 2000, end: 3000, text: "Third." },
  { type: "paragraph", start: 1000, end: 2000 },
] as readonly TranscriptBlock[]

describe("readStudioMeta", () => {
  it("returns null when there is no meta", () => {
    expect(readStudioMeta(null)).toBeNull()
  })

  it("returns null when the meta carries no studio edit", () => {
    expect(readStudioMeta({ other: 1 } as unknown as NoteMeta)).toBeNull()
  })

  it("returns the saved edit", () => {
    const meta = { studio: { text: "x", title: "y" } } as unknown as NoteMeta
    expect(readStudioMeta(meta)).toEqual({ text: "x", title: "y" })
  })
})

describe("nextStudioMeta", () => {
  it("returns null when neither value changed", () => {
    const meta = { studio: { text: "x", title: "y" } } as unknown as NoteMeta
    expect(nextStudioMeta(meta, "x", "y")).toBeNull()
  })

  it("treats a missing title as an empty one", () => {
    const meta = { studio: { text: "x" } } as unknown as NoteMeta
    expect(nextStudioMeta(meta, "x", "")).toBeNull()
  })

  it("keeps the rest of the meta", () => {
    const meta = { other: 1, studio: { text: "x" } } as unknown as NoteMeta
    expect(nextStudioMeta(meta, "z", "")).toEqual({ other: 1, studio: { text: "z" } })
  })

  it("drops the title once it is cleared", () => {
    const meta = { studio: { text: "x", title: "y" } } as unknown as NoteMeta
    expect(nextStudioMeta(meta, "x", "")).toEqual({ studio: { text: "x" } })
  })

  it("writes a first edit onto a note with no meta at all", () => {
    expect(nextStudioMeta(null, "x", "y")).toEqual({ studio: { text: "x", title: "y" } })
  })
})

describe("studioShareRange", () => {
  const note = { id: "n1", timeStart: 10, timeEnd: 20 }
  const citation = { trackId: "t1", startMs: 30, endMs: 40 }

  it("has nothing to share without a subject", () => {
    expect(studioShareRange(null, null)).toBeNull()
  })

  it("cuts a note between its own bounds", () => {
    expect(studioShareRange(note, null)).toEqual({
      subject: { kind: "note", noteId: "n1" },
      startMs: 10,
      endMs: 20,
    })
  })

  it("prefers the citation when one is loaded", () => {
    expect(studioShareRange(note, citation)).toEqual({
      subject: { kind: "citation", trackId: "t1", startMs: 30, endMs: 40 },
      startMs: 30,
      endMs: 40,
    })
  })
})

describe("joinOverlappingSentences", () => {
  it("joins the overlapping sentences, trimmed", () => {
    expect(joinOverlappingSentences(blocks, 900, 1500)).toBe("First. Second.")
  })

  it("ignores a block that is not a sentence", () => {
    expect(joinOverlappingSentences(blocks, 1000, 2000)).toBe("First. Second. Third.")
  })

  it("is empty when nothing overlaps", () => {
    expect(joinOverlappingSentences(blocks, 5000, 6000)).toBe("")
  })
})

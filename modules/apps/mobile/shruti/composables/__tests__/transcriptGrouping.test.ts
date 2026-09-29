import { describe, expect, it } from "vitest"
import type { NoteId } from "@lib/domain/core.js"
import { attachTrailingChapter, collectNoteOverlap } from "../transcriptGrouping.js"
import type { UiTranscriptBlocksGroup } from "@ui/features/transcript/index.js"

describe("collectNoteOverlap", () => {
  const ranges = [
    { id: "n1" as NoteId, start: 0, end: 500 },
    { id: "n2" as NoteId, start: 400, end: 900 },
    { start: 2000, end: 3000 },
  ]

  it("collects every overlapping note id", () => {
    expect(collectNoteOverlap(ranges, 450, 460)).toEqual({
      bookmarked: true,
      noteIds: ["n1", "n2"],
    })
  })

  it("marks a bookmark without an id but reports no ids", () => {
    expect(collectNoteOverlap(ranges, 2100, 2200)).toEqual({ bookmarked: true, noteIds: [] })
  })

  it("treats the ranges as half-open", () => {
    expect(collectNoteOverlap(ranges, 500, 600).noteIds).toEqual(["n2"])
  })

  it("reports nothing outside every range", () => {
    expect(collectNoteOverlap(ranges, 1000, 1500)).toEqual({ bookmarked: false, noteIds: [] })
  })
})

describe("attachTrailingChapter", () => {
  const group = (heading?: string): UiTranscriptBlocksGroup =>
    ({ blocks: [], heading }) as unknown as UiTranscriptBlocksGroup

  it("stamps the last unreached chapter onto the final group", () => {
    const groups = [group(), group()]
    attachTrailingChapter(groups, [
      { title: "A", startMs: 10 },
      { title: "B", startMs: 20 },
    ])
    expect(groups[1].heading).toBe("B")
    expect(groups[1].headingStartMs).toBe(20)
  })

  it("leaves a group that already has a heading", () => {
    const groups = [group("Kept")]
    attachTrailingChapter(groups, [{ title: "A", startMs: 10 }])
    expect(groups[0].heading).toBe("Kept")
  })

  it("does nothing without groups or without trailing chapters", () => {
    const groups: UiTranscriptBlocksGroup[] = []
    attachTrailingChapter(groups, [{ title: "A", startMs: 10 }])
    expect(groups).toEqual([])
    const one = [group()]
    attachTrailingChapter(one, [])
    expect(one[0].heading).toBeUndefined()
  })
})

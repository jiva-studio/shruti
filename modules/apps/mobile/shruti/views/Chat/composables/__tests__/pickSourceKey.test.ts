import { describe, expect, it } from "vitest"
import type { Track } from "@lib/domain/track.js"
import { citationExcerptId, pickSourceKey } from "../useCitationSnippet.js"

function track(variants: unknown[]): Track {
  return { id: "t1", variants } as unknown as Track
}

describe("pickSourceKey", () => {
  it("derives the key from the id when the catalog has no row", () => {
    expect(pickSourceKey(null, "t1")).toContain("t1")
  })

  it("uses the playable variant's audio path", () => {
    const t = track([{ language: "ru", audio: { path: "library/t1.mp3" } }])
    expect(pickSourceKey(t, "t1")).toBe("library/t1.mp3")
  })

  it("refuses a local track that has no audio at all", () => {
    expect(() => pickSourceKey(track([{ language: "ru" }]), "t1")).toThrow("no-audio")
  })
})

describe("citationExcerptId", () => {
  it("is stable for the same track and window", () => {
    const ref = { trackId: "t1", startMs: 10, endMs: 20 }
    expect(citationExcerptId(ref)).toBe(citationExcerptId({ ...ref }))
  })

  it("does not collide with a note's share id", () => {
    expect(citationExcerptId({ trackId: "t1", startMs: 0, endMs: 1 })).toMatch(/^chat-cite-/)
  })
})

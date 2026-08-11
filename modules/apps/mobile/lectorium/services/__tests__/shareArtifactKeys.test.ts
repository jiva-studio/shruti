import { describe, expect, it } from "vitest"
import {
  studioVideoArtifact,
  transcriptPdfCacheKey,
  type StudioVideoSubject,
} from "../shareArtifactKeys.js"

/**
 * `resolveShareArtifact` returns a local cache hit before any probe, so
 * these keys are the only thing keeping two different artifacts apart.
 * #1588: two languages of one lecture share a display title. #1584: an
 * edited Studio caption is a different video.
 */
describe("transcriptPdfCacheKey", () => {
  it("separates two languages of the same track", () => {
    expect(transcriptPdfCacheKey("track_abc", "ru")).not.toBe(
      transcriptPdfCacheKey("track_abc", "en")
    )
  })

  it("separates two tracks", () => {
    expect(transcriptPdfCacheKey("track_abc", "ru")).not.toBe(
      transcriptPdfCacheKey("track_xyz", "ru")
    )
  })

  it("is stable for the same track and language", () => {
    expect(transcriptPdfCacheKey("track_abc", "ru")).toBe(transcriptPdfCacheKey("track_abc", "ru"))
  })

  it("strips path and filesystem-unsafe characters", () => {
    expect(transcriptPdfCacheKey("track/../abc", "ru:x")).toBe("transcript-track-abc-ru-x.pdf")
  })
})

describe("studioVideoArtifact", () => {
  const note: StudioVideoSubject = { kind: "note", noteId: "note_AbCdEfGhIjKl" }
  const citation: StudioVideoSubject = {
    kind: "citation",
    trackId: "track_abc",
    startMs: 1000,
    endMs: 5000,
  }
  const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/

  it("gives an edited note caption a different id and filename", async () => {
    const before = await studioVideoArtifact(note, { text: "original quote", title: "" })
    const after = await studioVideoArtifact(note, { text: "edited quote", title: "" })
    expect(after.videoId).not.toBe(before.videoId)
    expect(after.filename).not.toBe(before.filename)
  })

  it("gives an added title card a different id", async () => {
    const untitled = await studioVideoArtifact(note, { text: "quote", title: "" })
    const titled = await studioVideoArtifact(note, { text: "quote", title: "On faith" })
    expect(titled.videoId).not.toBe(untitled.videoId)
  })

  it("does not collapse a word moved from the caption into the title", async () => {
    const a = await studioVideoArtifact(note, { text: "faith is", title: "eternal" })
    const b = await studioVideoArtifact(note, { text: "faith", title: "is eternal" })
    expect(a.videoId).not.toBe(b.videoId)
  })

  it("returns to the original key when the edit is reverted", async () => {
    const first = await studioVideoArtifact(note, { text: "original", title: "" })
    await studioVideoArtifact(note, { text: "edited", title: "" })
    const reverted = await studioVideoArtifact(note, { text: "original", title: "" })
    expect(reverted).toEqual(first)
  })

  it("separates two notes with identical text", async () => {
    const other: StudioVideoSubject = { kind: "note", noteId: "note_ZzZzZzZzZzZz" }
    const a = await studioVideoArtifact(note, { text: "same", title: "" })
    const b = await studioVideoArtifact(other, { text: "same", title: "" })
    expect(a.videoId).not.toBe(b.videoId)
  })

  it("gives an edited citation caption a different id", async () => {
    const before = await studioVideoArtifact(citation, { text: "as spoken", title: "" })
    const after = await studioVideoArtifact(citation, { text: "as edited", title: "" })
    expect(after.videoId).not.toBe(before.videoId)
    expect(after.videoId.startsWith("cit_")).toBe(true)
  })

  it("still separates two citation ranges of the same track", async () => {
    const later: StudioVideoSubject = { ...citation, startMs: 9000, endMs: 12000 }
    const a = await studioVideoArtifact(citation, { text: "same", title: "" })
    const b = await studioVideoArtifact(later, { text: "same", title: "" })
    expect(a.videoId).not.toBe(b.videoId)
  })

  it("keeps the id within the share-video video_id contract", async () => {
    const long: StudioVideoSubject = { kind: "note", noteId: `note/${"x".repeat(120)}` }
    const { videoId, filename } = await studioVideoArtifact(long, {
      text: "a".repeat(5000),
      title: "b".repeat(500),
    })
    expect(videoId).toMatch(VIDEO_ID)
    expect(filename).toBe(`share-video-${videoId}.mp4`)
  })
})

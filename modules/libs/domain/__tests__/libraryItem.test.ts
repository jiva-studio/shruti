import { describe, expect, it } from "vitest"
import { libraryItemToTrack, type LibraryItem } from "../libraryItem.js"

/** A ready personal-library item with all content fields populated. */
function readyItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "mem-1",
    trackId: "hash-abc",
    status: "ready",
    origin: "private",
    titleRaw: "A lecture on BG 2.13",
    authorRaw: "Some Swami",
    locationRaw: "Vrindavan",
    dateRaw: "1972",
    langHint: "en",
    authorId: "author-9",
    locationId: "loc-7",
    date: "1972-01-01",
    datePrecision: "year",
    lang: "en",
    langConfidence: 0.98,
    error: null,
    audioKey: null,
    transcriptKey: null,
    duration: 3_600_000,
    coverKey: null,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

describe("libraryItemToTrack — synthetic Track adapter", () => {
  it("returns null when the item has no content hash yet", () => {
    expect(libraryItemToTrack(readyItem({ trackId: null, status: "processing" }))).toBeNull()
  })

  it("derives content-addressed variant paths from the track_id", () => {
    const track = libraryItemToTrack(readyItem())
    expect(track).not.toBeNull()
    expect(track!.id).toBe("hash-abc")
    const variant = track!.variants[0]!
    // Audio path points at the standard content-addressed CDN location, so the
    // existing storage-URL resolver / download store consume it unchanged.
    expect(variant.audio?.path).toBe("public/tracks/hash-abc/audio/original.mp3")
    expect(variant.audio?.kind).toBe("original")
    expect(variant.audio?.duration).toBe(3_600_000)
    // Transcript path follows the `<lang>.json` scheme.
    expect(variant.transcript?.path).toBe("public/tracks/hash-abc/transcripts/en.json")
    expect(variant.transcript?.kind).toBe("generated")
  })

  it("prefers the server-supplied audio_key / transcript_key when present", () => {
    const track = libraryItemToTrack(
      readyItem({
        audioKey: "public/tracks/hash-abc/audio/clean.mp3",
        transcriptKey: "public/tracks/hash-abc/transcripts/custom.json",
      })
    )
    const variant = track!.variants[0]!
    expect(variant.audio?.path).toBe("public/tracks/hash-abc/audio/clean.mp3")
    expect(variant.transcript?.path).toBe("public/tracks/hash-abc/transcripts/custom.json")
  })

  it("falls back lang → langHint → 'en' for the variant language", () => {
    expect(libraryItemToTrack(readyItem({ lang: "ru" }))!.variants[0]!.language).toBe("ru")
    expect(
      libraryItemToTrack(readyItem({ lang: null, langHint: "hi" }))!.variants[0]!.language
    ).toBe("hi")
    expect(
      libraryItemToTrack(readyItem({ lang: null, langHint: null }))!.variants[0]!.language
    ).toBe("en")
  })

  it("carries resolved metadata and a playable variant onto the Track", () => {
    const track = libraryItemToTrack(readyItem())!
    expect(track.authorId).toBe("author-9")
    expect(track.locationId).toBe("loc-7")
    expect(track.date).toBe("1972-01-01")
    expect(track.hidden).toBe(false)
    expect(track.variants[0]!.title).toBe("A lecture on BG 2.13")
    expect(track.variants[0]!.audio).not.toBeNull()
  })

  it("omits the transcript ref while still processing with no key yet", () => {
    const track = libraryItemToTrack(
      readyItem({ status: "processing", audioKey: null, transcriptKey: null })
    )
    expect(track!.variants[0]!.transcript).toBeNull()
    // Audio path is still derivable once the content hash exists.
    expect(track!.variants[0]!.audio?.path).toBe("public/tracks/hash-abc/audio/original.mp3")
  })
})

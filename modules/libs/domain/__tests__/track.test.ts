import { describe, expect, it } from "vitest"

import { canonicalAudioPath, pickPlayableVariant } from "../track.js"
import type { Track } from "../track.js"
import type { TrackVariant } from "../trackVariant.js"

function variant(overrides: Partial<TrackVariant> = {}): TrackVariant {
  return {
    language: "ru",
    title: "Заголовок",
    audio: { path: "public/tracks/track_X/audio/clean.mp3", filesize: 1, duration: 1 },
    ...overrides,
  } as TrackVariant
}

describe("canonicalAudioPath", () => {
  it("matches the key the catalog stores in track_audio.path", () => {
    expect(canonicalAudioPath("track_NgSSQKYY72Vt")).toBe(
      "public/tracks/track_NgSSQKYY72Vt/audio/original.mp3"
    )
  })

  it("is derivable from the id alone, so a track missing from the local catalog stays playable", () => {
    // The citation surfaces fall back to this when `tracks.getById` misses —
    // a device whose catalog snapshot predates the cited lecture.
    expect(canonicalAudioPath("track_zHRUf4XRn1zp")).toContain("track_zHRUf4XRn1zp")
  })
})

describe("pickPlayableVariant", () => {
  it("prefers a variant that has audio", () => {
    const track = {
      variants: [variant({ audio: null }), variant()],
    } as unknown as Track
    expect(pickPlayableVariant(track)?.audio?.path).toBe(
      "public/tracks/track_X/audio/clean.mp3"
    )
  })

  it("returns null for a translation-only track", () => {
    const track = { variants: [variant({ audio: null })] } as unknown as Track
    expect(pickPlayableVariant(track)).toBeNull()
  })
})

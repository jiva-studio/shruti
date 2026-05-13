import { describe, expect, it } from "vitest"
import { playTrack } from "../playTrack.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"
import type { Author } from "@lib/domain/author.js"
import type { AuthorId, LanguageCode, TrackId } from "@lib/domain/core.js"

const mkVariant = (lang: LanguageCode, hasAudio: boolean): TrackVariant => ({
  trackId: "t-1" as TrackId,
  language: lang,
  title: `Title ${lang}`,
  audio: hasAudio
    ? { path: `public/audio/${lang}.mp3`, filesize: 100, duration: 60_000, kind: "original" }
    : null,
  transcript: null,
})

const mkTrack = (variants: readonly TrackVariant[]): Track => ({
  id: "t-1" as TrackId,
  authorId: "a-1" as AuthorId,
  locationId: null,
  date: "2020-01-01",
  hidden: false,
  references: [],
  tagIds: [],
  variants,
})

const mkAuthor = (names: Record<string, string>): Author => ({
  id: "a-1" as AuthorId,
  names: new Map(Object.entries(names) as [LanguageCode, string][]),
})

describe("playTrack", () => {
  it("picks the preferred-language variant when it has audio", async () => {
    const track = mkTrack([
      mkVariant("en", true),
      mkVariant("ru", true),
    ])
    const result = await playTrack({ track, preferredLanguage: "ru" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.language).toBe("ru")
      expect(result.value.matchesPreferred).toBe(true)
    }
  })

  it("falls back to the first variant with audio when preferred lacks audio", async () => {
    const track = mkTrack([
      mkVariant("ru", false),
      mkVariant("en", true),
    ])
    const result = await playTrack({ track, preferredLanguage: "ru" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.language).toBe("en")
      // Caller can detect "I asked for ru, got en" and surface UI.
      expect(result.value.matchesPreferred).toBe(false)
    }
  })

  it("reports matchesPreferred=true when no preference was supplied", async () => {
    const track = mkTrack([mkVariant("en", true)])
    const result = await playTrack({ track })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.matchesPreferred).toBe(true)
  })

  it("returns no-audio-available when no variant has audio", async () => {
    const track = mkTrack([mkVariant("ru", false), mkVariant("en", false)])
    const result = await playTrack({ track, preferredLanguage: "ru" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("no-audio-available")
  })

  it("generates a default itemId using the track id", async () => {
    const track = mkTrack([mkVariant("en", true)])
    const result = await playTrack({ track })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.itemId).toBe("track:t-1")
  })

  it("respects an explicit itemId override", async () => {
    const track = mkTrack([mkVariant("en", true)])
    const result = await playTrack({ track, itemId: "playlist:pi-5" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.itemId).toBe("playlist:pi-5")
  })

  it("resolves author name via the variant's language, falling back to first entry", async () => {
    const track = mkTrack([mkVariant("ru", true)])
    const author = mkAuthor({ en: "Anand", ru: "Ананд" })
    const result = await playTrack({ track, preferredLanguage: "ru", author })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.authorName).toBe("Ананд")
  })

  it("returns empty author name when author is null/undefined", async () => {
    const track = mkTrack([mkVariant("en", true)])
    const result = await playTrack({ track, author: null })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.authorName).toBe("")
  })
})

import { describe, it, expect } from "vitest"
import {
  reduceLocaleToContentLanguage,
  defaultLibraryLanguages,
} from "../reduceLocaleToLibraryLanguages.js"

describe("reduceLocaleToContentLanguage", () => {
  it("reduces East-Slavic UI locales to Russian", () => {
    expect(reduceLocaleToContentLanguage("ru")).toBe("ru")
    expect(reduceLocaleToContentLanguage("uk")).toBe("ru")
    expect(reduceLocaleToContentLanguage("ru-RU")).toBe("ru")
    expect(reduceLocaleToContentLanguage("uk_UA")).toBe("ru")
  })

  it("reduces everything else to English", () => {
    for (const l of ["en", "en-US", "sr-Latn", "hi", "de", "fr", "it", "bn", "zh"]) {
      expect(reduceLocaleToContentLanguage(l)).toBe("en")
    }
  })

  it("handles empty/garbage input", () => {
    expect(reduceLocaleToContentLanguage("")).toBe("en")
  })
})

describe("defaultLibraryLanguages", () => {
  const AVAIL = ["en", "ru"]

  it("seeds the reduced language when available", () => {
    expect(defaultLibraryLanguages("ru", AVAIL)).toEqual(["ru"])
    expect(defaultLibraryLanguages("uk", AVAIL)).toEqual(["ru"])
    expect(defaultLibraryLanguages("en", AVAIL)).toEqual(["en"])
    expect(defaultLibraryLanguages("de", AVAIL)).toEqual(["en"])
  })

  it("falls back to en when the reduced language has no content", () => {
    // A Ukrainian UI reduces to ru, but if only en content existed it'd take en.
    expect(defaultLibraryLanguages("uk", ["en"])).toEqual(["en"])
  })

  it("falls back to the first available when neither reduced nor en exists", () => {
    expect(defaultLibraryLanguages("ru", ["zh"])).toEqual(["zh"])
  })

  it("returns empty only when no content exists", () => {
    expect(defaultLibraryLanguages("ru", [])).toEqual([])
  })

  it("picks up a newly added content language automatically", () => {
    // If Chinese lectures are added and a zh UI reduces to en, en is still the
    // seed — but zh is now selectable in the filter (availability is dynamic).
    expect(defaultLibraryLanguages("ru", ["en", "ru", "zh"])).toEqual(["ru"])
  })
})

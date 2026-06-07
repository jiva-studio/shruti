import { describe, expect, it } from "vitest"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import {
  resolveLocalizedName,
  resolveLocalizedNameOrEmpty,
  resolveTrackTitle,
} from "../localizedName.js"

function entity(names: Array<[string, string]>): { names: ReadonlyMap<LanguageCode, string> } {
  return { names: new Map(names) as ReadonlyMap<LanguageCode, string> }
}

function track(variants: Array<{ language: string; title: string }>): Track {
  return {
    id: "t" as TrackId,
    authorId: null,
    locationId: null,
    date: "1970-01-01" as Track["date"],
    hidden: false,
    references: [],
    tagIds: [],
    variants: variants.map((v) => ({
      trackId: "t" as TrackId,
      language: v.language as Track["variants"][number]["language"],
      title: v.title,
      audio: null,
      transcript: null,
    })),
  }
}

describe("resolveLocalizedName", () => {
  it("returns the preferred language when present", () => {
    expect(
      resolveLocalizedName(
        entity([
          ["en", "Author"],
          ["ru", "Автор"],
        ]),
        "ru"
      )
    ).toBe("Автор")
  })

  it("falls back to the first available name when the preferred lang is missing", () => {
    expect(resolveLocalizedName(entity([["en", "Author"]]), "ru")).toBe("Author")
  })

  it("returns undefined for an undefined entity", () => {
    expect(resolveLocalizedName(undefined, "en")).toBeUndefined()
    expect(resolveLocalizedName(null, "en")).toBeUndefined()
  })

  it("returns undefined when every available name is empty", () => {
    expect(
      resolveLocalizedName(
        entity([
          ["en", ""],
          ["ru", ""],
        ]),
        "en"
      )
    ).toBeUndefined()
  })

  it("falls back to the first NON-empty entry when earlier entries are empty", () => {
    // Previously the helper returned the first map entry verbatim, so an
    // empty leading entry masked a perfectly good later name. It now skips
    // empties and returns the first non-empty value.
    expect(
      resolveLocalizedName(
        entity([
          ["en", ""],
          ["ru", "Имя"],
        ]),
        "en"
      )
    ).toBe("Имя")
  })

  it("falls back past several empty entries to the first non-empty one", () => {
    expect(
      resolveLocalizedName(
        entity([
          ["en", ""],
          ["ru", ""],
          ["es", "Nombre"],
        ]),
        "en"
      )
    ).toBe("Nombre")
  })
})

describe("resolveLocalizedNameOrEmpty", () => {
  it("returns empty string when no name resolves", () => {
    expect(resolveLocalizedNameOrEmpty(undefined, "en")).toBe("")
    expect(resolveLocalizedNameOrEmpty(entity([]), "en")).toBe("")
  })

  it("matches resolveLocalizedName when a name resolves", () => {
    expect(resolveLocalizedNameOrEmpty(entity([["en", "X"]]), "en")).toBe("X")
  })
})

describe("resolveTrackTitle", () => {
  it("picks the variant matching the preferred language", () => {
    expect(
      resolveTrackTitle(
        track([
          { language: "en", title: "Hello" },
          { language: "ru", title: "Привет" },
        ]),
        "ru"
      )
    ).toBe("Привет")
  })

  it("falls back to the first variant when the preferred lang has no variant", () => {
    expect(resolveTrackTitle(track([{ language: "en", title: "Hello" }]), "ru")).toBe("Hello")
  })

  it("returns undefined when the track has no variants", () => {
    expect(resolveTrackTitle(track([]), "en")).toBeUndefined()
  })

  it("returns undefined when the chosen variant title is empty", () => {
    expect(resolveTrackTitle(track([{ language: "en", title: "" }]), "en")).toBeUndefined()
  })

  it("returns undefined for an undefined/null track", () => {
    expect(resolveTrackTitle(undefined, "en")).toBeUndefined()
    expect(resolveTrackTitle(null, "en")).toBeUndefined()
  })
})

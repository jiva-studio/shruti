import { describe, expect, it } from "vitest"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import {
  preferredContentLanguage,
  preferredLibraryLanguage,
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
    topicIds: [],
    variants: variants.map((v) => ({
      trackId: "t" as TrackId,
      language: v.language as Track["variants"][number]["language"],
      title: v.title,
      audios: [],
      audio: null,
      transcript: null,
      outline: null,
      description: null,
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

describe("chat-card title path (content language vs UI language)", () => {
  // The canonical expression every chat card / mini-row uses to title a track:
  // the TITLE follows the content language (a library language the track has),
  // while the surrounding UI stays on `ui`. Guards the leak the PR fixes —
  // a Russian-UI user reading English lectures must see the English title.
  function cardTitle(t: Track, library: LanguageCode[], ui: LanguageCode): string | undefined {
    const cl = preferredContentLanguage(t, library, ui) ?? ui
    return resolveTrackTitle(t, cl)
  }

  const bilingual = track([
    { language: "en", title: "Hello" },
    { language: "ru", title: "Привет" },
  ])

  it("titles in the CONTENT language even when the UI language differs", () => {
    // English library, Russian UI → English title (not the UI-driven "Привет").
    expect(cardTitle(bilingual, ["en"], "ru")).toBe("Hello")
    // Russian library, English UI → Russian title.
    expect(cardTitle(bilingual, ["ru"], "en")).toBe("Привет")
  })

  it("falls back to the track's own variant when it lacks every library language", () => {
    // ru-only track, English library + UI → still its Russian title, not blank.
    expect(cardTitle(track([{ language: "ru", title: "Привет" }]), ["en"], "en")).toBe("Привет")
  })

  it("with no library languages set, the UI language only orders the fallback", () => {
    // Empty library → first available variant title.
    expect(cardTitle(bilingual, [], "ru")).toBe("Hello")
  })
})

describe("preferredContentLanguage", () => {
  const bilingual = track([
    { language: "en", title: "Hello" },
    { language: "ru", title: "Привет" },
  ])

  it("picks the first library language the track actually has", () => {
    expect(preferredContentLanguage(bilingual, ["ru"])).toBe("ru")
    expect(preferredContentLanguage(bilingual, ["en"])).toBe("en")
    // No UI tie-break → falls to library priority order when the track has both.
    expect(preferredContentLanguage(bilingual, ["ru", "en"])).toBe("ru")
    expect(preferredContentLanguage(bilingual, ["en", "ru"])).toBe("en")
  })

  it("breaks a both-selected tie by the UI language", () => {
    // Both library languages match the track → prefer the UI language.
    expect(preferredContentLanguage(bilingual, ["ru", "en"], "en")).toBe("en")
    expect(preferredContentLanguage(bilingual, ["en", "ru"], "ru")).toBe("ru")
  })

  it("ignores the UI language when it is not among the matching library languages", () => {
    // Only ru is selected: the UI being English must NOT pull the en variant in
    // — selection stays library-driven, the tie-break only orders chosen langs.
    expect(preferredContentLanguage(bilingual, ["ru"], "en")).toBe("ru")
    // ru-only track, en UI, en library → no ru candidate, falls back to the
    // track's only variant.
    expect(
      preferredContentLanguage(track([{ language: "ru", title: "Привет" }]), ["en"], "en")
    ).toBe("ru")
  })

  it("falls back to the track's own variant when it has none of the library languages", () => {
    // A single-language (ru-only) track viewed with an en-only library: still
    // renders in its one language rather than blank.
    expect(preferredContentLanguage(track([{ language: "ru", title: "Привет" }]), ["en"])).toBe(
      "ru"
    )
    // No library languages set → first available.
    expect(preferredContentLanguage(bilingual, [])).toBe("en")
  })

  it("returns undefined for a track with no variants", () => {
    expect(preferredContentLanguage(track([]), ["en"])).toBeUndefined()
  })
})

describe("preferredLibraryLanguage", () => {
  it("picks the single selected library language, regardless of the UI language", () => {
    // The collections bug: a Russian library on an English UI must load the
    // Russian collection, not the English one.
    expect(preferredLibraryLanguage(["ru"], "en")).toBe("ru")
    expect(preferredLibraryLanguage(["en"], "ru")).toBe("en")
  })

  it("prefers the UI language when it is among the selected library languages", () => {
    expect(preferredLibraryLanguage(["en", "ru"], "ru")).toBe("ru")
    expect(preferredLibraryLanguage(["en", "ru"], "en")).toBe("en")
  })

  it("falls back to the first library language when the UI language is not selected", () => {
    // es UI, but only en+ru in the library → first in library priority order.
    expect(preferredLibraryLanguage(["ru", "en"], "es")).toBe("ru")
    expect(preferredLibraryLanguage(["en", "ru"], "es")).toBe("en")
  })

  it("falls back to the UI language when no library language is selected", () => {
    expect(preferredLibraryLanguage([], "en")).toBe("en")
    expect(preferredLibraryLanguage([], "ru")).toBe("ru")
  })
})

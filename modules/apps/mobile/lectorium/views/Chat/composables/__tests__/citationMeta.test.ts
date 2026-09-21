import { describe, expect, it } from "vitest"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { formatCitationMeta } from "../citationMeta.js"

const RU = "ru" as LanguageCode
const sources = new Map()

function track(partial: Partial<Track>): Track {
  return { id: "t1", references: [], variants: [], ...partial } as unknown as Track
}

describe("formatCitationMeta", () => {
  it("yields empty fields for a track the catalog does not hold", () => {
    expect(formatCitationMeta({ track: null, author: null }, RU, ["ru"], sources)).toEqual({
      trackTitle: "",
      authorName: "",
      reference: "",
      trackDate: "",
    })
  })

  it("takes the title from a library language the track has", () => {
    const t = track({
      variants: [{ language: "en", title: "Lecture" }] as unknown as Track["variants"],
    })
    const meta = formatCitationMeta({ track: t, author: null }, RU, ["en"], sources)
    expect(meta.trackTitle).toBe("Lecture")
  })

  it("localizes the author name to the UI language", () => {
    const author = { id: "a1", names: new Map([["ru", "Радханатха Свами"]]) } as unknown as Author
    const meta = formatCitationMeta({ track: track({}), author }, RU, ["ru"], sources)
    expect(meta.authorName).toBe("Радханатха Свами")
  })

  it("prints an empty date rather than a null one", () => {
    const meta = formatCitationMeta(
      { track: track({ date: null as unknown as string }), author: null },
      RU,
      ["ru"],
      sources
    )
    expect(meta.trackDate).toBe("")
  })
})

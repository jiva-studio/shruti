import { describe, expect, it } from "vitest"
import type { Track } from "@lib/domain/track.js"
import { filterByLanguages, hydrateTracks } from "../collectionTracks.js"

function track(id: string, languages: string[]): Track {
  return { id, variants: languages.map((language) => ({ language })) } as unknown as Track
}

describe("hydrateTracks", () => {
  it("keeps the order the ids were given in", () => {
    const byId = new Map([
      ["b", track("b", ["ru"])],
      ["a", track("a", ["ru"])],
    ])
    expect(hydrateTracks(["a", "b"], byId).map((t) => t.id)).toEqual(["a", "b"])
  })

  it("skips ids the catalog has no row for", () => {
    const byId = new Map([["a", track("a", ["ru"])]])
    expect(hydrateTracks(["a", "missing"], byId).map((t) => t.id)).toEqual(["a"])
  })
})

describe("filterByLanguages", () => {
  it("returns everything when no language is set", () => {
    const tracks = [track("a", ["ru"]), track("b", ["en"])]
    expect(filterByLanguages(tracks, [])).toEqual(tracks)
  })

  it("keeps a track that has any variant in the chosen languages", () => {
    const tracks = [track("a", ["ru", "en"]), track("b", ["hi"])]
    expect(filterByLanguages(tracks, ["en"]).map((t) => t.id)).toEqual(["a"])
  })
})

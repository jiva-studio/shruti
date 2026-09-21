import { describe, expect, it } from "vitest"
import type {
  AuthorId,
  IsoDate,
  LanguageCode,
  LocationId,
  SourceId,
  TagId,
  TrackId,
} from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { buildShareCover, type ShareCoverDictionaries } from "../shareCover.js"

const EN = "en" as LanguageCode
const RU = "ru" as LanguageCode

const dicts: ShareCoverDictionaries = {
  authorsById: new Map([["a-1", { id: "a-1" as AuthorId, names: new Map([[EN, "Prabhupada"]]) }]]),
  locationsById: new Map([
    ["l-1", { id: "l-1" as LocationId, names: new Map([[EN, "New York"]]) }],
  ]),
  sourcesById: new Map([
    [
      "s-1",
      {
        id: "s-1" as SourceId,
        names: new Map([[RU, { shortName: "БГ", fullName: "Бхагавад-гита" }]]),
      },
    ],
  ]),
  tagsById: new Map([["t-1", { id: "t-1" as TagId, names: new Map([[EN, "Conversation"]]) }]]),
} as unknown as ShareCoverDictionaries

const track = (over: Partial<Track> = {}): Track =>
  ({
    id: "track_1" as TrackId,
    authorId: "a-1" as AuthorId,
    locationId: "l-1" as LocationId,
    date: "1975-01-01" as IsoDate,
    hidden: false,
    references: [],
    tagIds: ["t-1" as TagId],
    topicIds: [],
    variants: [{ language: EN, title: "Arrival lecture", outline: { chapters: [] } }],
    ...over,
  }) as unknown as Track

describe("buildShareCover", () => {
  it("resolves the localized cover fields", () => {
    const cover = buildShareCover(track(), dicts, EN)
    expect(cover.title).toBe("Arrival lecture")
    expect(cover.author).toBe("Prabhupada")
    expect(cover.location).toBe("New York")
    expect(cover.date).toBe("1975-01-01")
    expect(cover.tags).toEqual(["Conversation"])
    expect(cover.outline).toEqual({ chapters: [] })
  })

  it("falls back to a source's first name when the language is missing", () => {
    const cover = buildShareCover(
      track({ references: [{ sourceId: "s-1", tokens: ["2", "13"] }] as Track["references"] }),
      dicts,
      EN
    )
    expect(cover.references).toEqual([
      { shortName: "БГ", fullName: "Бхагавад-гита", sourceId: "s-1", tokens: "2.13" },
    ])
  })

  it("nulls a reference whose source is unknown", () => {
    const cover = buildShareCover(
      track({ references: [{ sourceId: null, tokens: [] }] as unknown as Track["references"] }),
      dicts,
      EN
    )
    expect(cover.references).toEqual([
      { shortName: null, fullName: null, sourceId: null, tokens: null },
    ])
  })

  it("returns an empty cover for an unknown track", () => {
    expect(buildShareCover(null, dicts, EN)).toEqual({
      title: null,
      author: null,
      date: null,
      location: null,
      references: [],
      tags: [],
      outline: null,
    })
  })

  it("leaves the outline out when the track has no variant in that language", () => {
    expect(buildShareCover(track(), dicts, RU).outline).toBeNull()
  })
})

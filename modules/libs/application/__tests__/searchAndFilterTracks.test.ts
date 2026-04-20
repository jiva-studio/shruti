import { describe, expect, it, vi } from "vitest"
import { searchAndFilterTracks } from "../searchAndFilterTracks.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import type { AuthorId, TrackId } from "@lib/domain/core.js"

const mkTrack = (over: Partial<Track> & Pick<Track, "id">): Track => ({
  authorId: null,
  locationId: null,
  date: "2020-01-01",
  hidden: false,
  sortReference: "",
  sortDate: "2020-01-01",
  references: [],
  tagIds: [],
  variants: [],
  ...over,
})

function makeRepo(overrides: Partial<ITrackRepository> = {}): ITrackRepository {
  return {
    getById: async () => null,
    list: async () => [],
    search: async () => [],
    getTranscriptPath: async () => null,
    listTranscriptLanguages: async () => [],
    ...overrides,
  }
}

describe("searchAndFilterTracks", () => {
  it("routes to searchTracks when query has text and narrows by author filter", async () => {
    const searchSpy = vi.fn<ITrackRepository["search"]>().mockResolvedValue([
      mkTrack({ id: "t1" as TrackId, authorId: "a1" as AuthorId }),
      mkTrack({ id: "t2" as TrackId, authorId: "a2" as AuthorId }),
    ])
    const listSpy = vi.fn<ITrackRepository["list"]>()
    const repo = makeRepo({ search: searchSpy, list: listSpy })
    const result = await searchAndFilterTracks(
      { query: "bhagavad", authorIds: ["a1" as AuthorId] },
      { tracks: repo }
    )
    expect(result.map((t) => t.id)).toEqual(["t1"])
    expect(searchSpy).toHaveBeenCalled()
    expect(listSpy).not.toHaveBeenCalled()
  })

  it("routes to listTracksByFilters when query is empty", async () => {
    const searchSpy = vi.fn<ITrackRepository["search"]>()
    const listSpy = vi
      .fn<ITrackRepository["list"]>()
      .mockResolvedValue([mkTrack({ id: "t1" as TrackId })])
    const repo = makeRepo({ search: searchSpy, list: listSpy })
    const result = await searchAndFilterTracks(
      { query: "   ", authorIds: ["a1" as AuthorId] },
      { tracks: repo }
    )
    expect(result.map((t) => t.id)).toEqual(["t1"])
    expect(listSpy).toHaveBeenCalled()
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it("returns unmodified search results when no filters are active", async () => {
    const searchSpy = vi.fn<ITrackRepository["search"]>().mockResolvedValue([
      mkTrack({ id: "t1" as TrackId, authorId: "a1" as AuthorId }),
      mkTrack({ id: "t2" as TrackId, authorId: "a2" as AuthorId }),
    ])
    const repo = makeRepo({ search: searchSpy })
    const result = await searchAndFilterTracks({ query: "term" }, { tracks: repo })
    expect(result.map((t) => t.id)).toEqual(["t1", "t2"])
  })
})

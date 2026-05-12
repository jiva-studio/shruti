import { describe, expect, it, vi } from "vitest"
import { searchAndFilterTracks } from "../searchAndFilterTracks.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import type { AuthorId, SourceId, TagId, TrackId } from "@lib/domain/core.js"

const mkTrack = (over: Partial<Track> & Pick<Track, "id">): Track => ({
  authorId: null,
  locationId: null,
  date: "2020-01-01",
  hidden: false,
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
  it("routes to tracks.search when query has text and narrows by author filter", async () => {
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

  it("trims the query before passing it to tracks.search", async () => {
    const searchSpy = vi.fn<ITrackRepository["search"]>().mockResolvedValue([])
    const repo = makeRepo({ search: searchSpy })
    await searchAndFilterTracks({ query: "  джент  " }, { tracks: repo })
    expect(searchSpy).toHaveBeenCalledWith({
      text: "джент",
      limit: undefined,
      offset: undefined,
    })
  })

  it("forwards limit and offset on the search path", async () => {
    const searchSpy = vi.fn<ITrackRepository["search"]>().mockResolvedValue([])
    const repo = makeRepo({ search: searchSpy })
    await searchAndFilterTracks(
      { query: "sb 1.8.40", limit: 25, offset: 50 },
      { tracks: repo }
    )
    expect(searchSpy).toHaveBeenCalledWith({
      text: "sb 1.8.40",
      limit: 25,
      offset: 50,
    })
  })

  it("routes to tracks.list when query is empty", async () => {
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

  it("passes raw filters through to tracks.list when duration is not set", async () => {
    const listSpy = vi.fn<ITrackRepository["list"]>().mockResolvedValue([])
    const repo = makeRepo({ list: listSpy })
    await searchAndFilterTracks(
      {
        authorIds: ["a1" as AuthorId],
        tagIds: ["t1" as TagId],
        sortBy: "byDateDesc",
      },
      { tracks: repo }
    )
    expect(listSpy).toHaveBeenCalledWith({
      filters: {
        authorIds: ["a1"],
        locationIds: undefined,
        languageCodes: undefined,
        sourceIds: undefined,
        tagIds: ["t1"],
        durationMinMs: undefined,
        durationMaxMs: undefined,
      },
      sortBy: "byDateDesc",
      limit: undefined,
      offset: undefined,
    })
  })

  it("expands a duration filter id into numeric bounds on the list path", async () => {
    const listSpy = vi.fn<ITrackRepository["list"]>().mockResolvedValue([])
    const repo = makeRepo({ list: listSpy })

    await searchAndFilterTracks({ durationFilter: "short" }, { tracks: repo })
    expect(listSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          durationMinMs: 0,
          durationMaxMs: 30 * 60 * 1000,
        }),
      }),
    )

    await searchAndFilterTracks({ durationFilter: "long" }, { tracks: repo })
    expect(listSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          durationMinMs: 60 * 60 * 1000,
          durationMaxMs: Number.MAX_SAFE_INTEGER,
        }),
      }),
    )
  })

  it("forwards limit/offset/sortBy on the list path", async () => {
    const listSpy = vi.fn<ITrackRepository["list"]>().mockResolvedValue([])
    const repo = makeRepo({ list: listSpy })
    await searchAndFilterTracks(
      { sortBy: "byReference", limit: 20, offset: 40 },
      { tracks: repo }
    )
    expect(listSpy.mock.calls[0][0]).toMatchObject({
      sortBy: "byReference",
      limit: 20,
      offset: 40,
    })
  })

  it("narrows FTS results by sourceIds against track references", async () => {
    const searchSpy = vi.fn<ITrackRepository["search"]>().mockResolvedValue([
      mkTrack({
        id: "t1" as TrackId,
        references: [{ sourceId: "src_bg" as SourceId, tokens: ["1", "1"] }],
      }),
      mkTrack({
        id: "t2" as TrackId,
        references: [{ sourceId: "src_sb" as SourceId, tokens: ["1", "8", "40"] }],
      }),
      mkTrack({
        id: "t3" as TrackId,
        references: [
          { sourceId: "src_cc" as SourceId, tokens: ["1", "1"] },
          { sourceId: "src_bg" as SourceId, tokens: ["2", "13"] },
        ],
      }),
      mkTrack({ id: "t4" as TrackId, references: [] }),
    ])
    const repo = makeRepo({ search: searchSpy })
    const result = await searchAndFilterTracks(
      { query: "krishna", sourceIds: ["src_bg" as SourceId] },
      { tracks: repo }
    )
    expect(result.map((t) => t.id)).toEqual(["t1", "t3"])
    expect(searchSpy).toHaveBeenCalled()
  })

  it("forwards sourceIds into tracks.list filters on the empty-query path", async () => {
    const listSpy = vi.fn<ITrackRepository["list"]>().mockResolvedValue([])
    const repo = makeRepo({ list: listSpy })
    await searchAndFilterTracks(
      { sourceIds: ["src_bg" as SourceId, "src_sb" as SourceId] },
      { tracks: repo }
    )
    expect(listSpy).toHaveBeenCalledWith({
      filters: {
        authorIds: undefined,
        locationIds: undefined,
        languageCodes: undefined,
        sourceIds: ["src_bg", "src_sb"],
        tagIds: undefined,
        durationMinMs: undefined,
        durationMaxMs: undefined,
      },
      sortBy: undefined,
      limit: undefined,
      offset: undefined,
    })
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

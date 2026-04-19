import { describe, expect, it, vi } from "vitest"
import { searchTracks } from "../searchTracks.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"

function makeRepo(): {
  repo: ITrackRepository
  search: ReturnType<typeof vi.fn>
} {
  const search = vi.fn((async () => [] as readonly Track[]) as never)
  const repo: ITrackRepository = {
    getById: vi.fn(),
    list: vi.fn((async () => [] as readonly Track[]) as never),
    search,
    getTranscriptPath: vi.fn(async () => null),
    listTranscriptLanguages: vi.fn(async () => []),
  }
  return { repo, search }
}

describe("searchTracks", () => {
  it("routes a reference-shaped query through referenceTokens", async () => {
    const { repo, search } = makeRepo()
    await searchTracks({ query: "sb 1.8.40" }, { tracks: repo })
    expect(search).toHaveBeenCalledWith({
      referenceTokens: ["sb", "1", "8", "40"],
      limit: undefined,
      offset: undefined,
    })
  })

  it("routes a free-text query through text + language", async () => {
    const { repo, search } = makeRepo()
    await searchTracks({ query: "chapter on bhakti", preferredLanguage: "en" }, { tracks: repo })
    expect(search).toHaveBeenCalledWith({
      text: "chapter on bhakti",
      language: "en",
      limit: undefined,
      offset: undefined,
    })
  })

  it("returns [] for empty / whitespace query without hitting the repo", async () => {
    const { repo, search } = makeRepo()
    expect(await searchTracks({ query: "" }, { tracks: repo })).toEqual([])
    expect(await searchTracks({ query: "   " }, { tracks: repo })).toEqual([])
    expect(search).not.toHaveBeenCalled()
  })

  it("forwards limit and offset on both branches", async () => {
    const { repo, search } = makeRepo()
    await searchTracks({ query: "sb 1", limit: 25, offset: 50 }, { tracks: repo })
    expect(search.mock.calls[0][0]).toMatchObject({ limit: 25, offset: 50 })
    await searchTracks({ query: "nitai", limit: 10 }, { tracks: repo })
    expect(search.mock.calls[1][0]).toMatchObject({ limit: 10 })
  })
})

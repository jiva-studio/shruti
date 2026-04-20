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
  it("forwards a trimmed query to the repo", async () => {
    const { repo, search } = makeRepo()
    await searchTracks({ query: "  джент  " }, { tracks: repo })
    expect(search).toHaveBeenCalledWith({
      text: "джент",
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

  it("forwards limit and offset", async () => {
    const { repo, search } = makeRepo()
    await searchTracks({ query: "sb 1.8.40", limit: 25, offset: 50 }, { tracks: repo })
    expect(search).toHaveBeenCalledWith({
      text: "sb 1.8.40",
      limit: 25,
      offset: 50,
    })
  })
})

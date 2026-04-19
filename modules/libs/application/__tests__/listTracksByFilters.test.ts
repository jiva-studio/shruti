import { describe, expect, it, vi } from "vitest"
import { listTracksByFilters } from "../listTracksByFilters.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"

function makeRepo(): { repo: ITrackRepository; list: ReturnType<typeof vi.fn> } {
  const list = vi.fn((async () => [] as readonly Track[]) as never)
  const repo: ITrackRepository = {
    getById: vi.fn(),
    list,
    search: vi.fn(),
    getTranscriptPath: vi.fn(async () => null),
    listTranscriptLanguages: vi.fn(async () => []),
  }
  return { repo, list }
}

describe("listTracksByFilters", () => {
  it("passes raw filters through unchanged when duration is not set", async () => {
    const { repo, list } = makeRepo()
    await listTracksByFilters(
      { authorIds: ["a1"], locationIds: ["l1"], tagIds: ["t1"], sortBy: "byDate" },
      { tracks: repo }
    )
    expect(list).toHaveBeenCalledWith({
      filters: {
        authorIds: ["a1"],
        locationIds: ["l1"],
        languageCodes: undefined,
        tagIds: ["t1"],
        durationMinMs: undefined,
        durationMaxMs: undefined,
      },
      sortBy: "byDate",
      limit: undefined,
      offset: undefined,
    })
  })

  it("expands a duration filter id into numeric bounds", async () => {
    const { repo, list } = makeRepo()
    await listTracksByFilters({ durationFilter: "short" }, { tracks: repo })
    const filters = list.mock.calls[0][0].filters
    expect(filters.durationMinMs).toBe(0)
    expect(filters.durationMaxMs).toBe(30 * 60 * 1000)

    await listTracksByFilters({ durationFilter: "long" }, { tracks: repo })
    const longFilters = list.mock.calls[1][0].filters
    expect(longFilters.durationMinMs).toBe(60 * 60 * 1000)
    expect(longFilters.durationMaxMs).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("forwards limit/offset/sortBy", async () => {
    const { repo, list } = makeRepo()
    await listTracksByFilters({ sortBy: "byReference", limit: 20, offset: 40 }, { tracks: repo })
    expect(list.mock.calls[0][0]).toMatchObject({
      sortBy: "byReference",
      limit: 20,
      offset: 40,
    })
  })
})

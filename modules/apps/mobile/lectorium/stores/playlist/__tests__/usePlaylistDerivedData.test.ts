import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistEntry } from "@usecases/playlist/listPlaylistTracks.js"

const getProgressForItems = vi.fn()
const getCompletedAtForItems = vi.fn()

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      listeningSessions: { getProgressForItems, getCompletedAtForItems },
    }),
  }),
}))

import { usePlaylistDerivedData } from "../usePlaylistDerivedData.js"

function entry(n: number, durationMs: number | null): PlaylistEntry {
  return {
    item: { id: `i-${n}` as PlaylistItemId },
    track: {
      id: `t-${n}` as TrackId,
      variants: durationMs === null ? [] : [{ audio: { duration: durationMs } }],
    },
  } as unknown as PlaylistEntry
}

describe("usePlaylistDerivedData.loadFor", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getProgressForItems.mockResolvedValue(new Map())
    getCompletedAtForItems.mockResolvedValue(new Map())
  })

  it("issues no SQL for an empty page", async () => {
    const result = await usePlaylistDerivedData().loadFor([])

    expect(result.progress.size).toBe(0)
    expect(result.completed.size).toBe(0)
    expect(getProgressForItems).not.toHaveBeenCalled()
    expect(getCompletedAtForItems).not.toHaveBeenCalled()
  })

  it("converts journal seconds to milliseconds on both maps", async () => {
    getProgressForItems.mockResolvedValue(new Map([["i-1", { position: 612 }]]))
    getCompletedAtForItems.mockResolvedValue(
      new Map([
        ["i-1", 1_700_000_000],
        ["i-2", null],
      ])
    )

    const result = await usePlaylistDerivedData().loadFor([entry(1, 60_000), entry(2, 60_000)])

    expect(result.progress.get("i-1" as PlaylistItemId)).toBe(612_000)
    expect(result.completed.get("i-1" as PlaylistItemId)).toBe(1_700_000_000_000)
    expect(result.completed.get("i-2" as PlaylistItemId)).toBeNull()
  })

  it("passes the catalog durations in seconds, omitting tracks with no audio", async () => {
    await usePlaylistDerivedData().loadFor([entry(1, 95_500), entry(2, null), entry(3, 0)])

    expect(getProgressForItems).toHaveBeenCalledWith(["i-1", "i-2", "i-3"])
    const [ids, durations] = getCompletedAtForItems.mock.calls[0]
    expect(ids).toEqual(["i-1", "i-2", "i-3"])
    expect([...durations]).toEqual([["i-1", 95]])
  })
})

import { describe, expect, it, vi } from "vitest"
import { addTrackToPlaylist } from "../addTrackToPlaylist.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"

function makeRepo(overrides: Partial<IPlaylistItemRepository> = {}): IPlaylistItemRepository {
  return {
    getById: async () => null,
    listActive: async () => [],
    listArchived: async () => [],
    add: async () => {
      throw new Error("add not stubbed")
    },
    updateProgress: async () => {},
    markCompleted: async () => {},
    archive: async () => {},
    remove: async () => {},
    clearAll: async () => {},
    ...overrides,
  }
}

const sample = (over: Partial<PlaylistItem> = {}): PlaylistItem => ({
  id: "pi-1" as PlaylistItemId,
  trackId: "t-1" as TrackId,
  addedAt: 1000,
  completedAt: null,
  archivedAt: null,
  progress: null,
  ...over,
})

describe("addTrackToPlaylist", () => {
  it("adds when the track is not already active", async () => {
    const created = sample({ id: "pi-new" as PlaylistItemId, trackId: "t-new" as TrackId })
    const add = vi.fn<IPlaylistItemRepository["add"]>().mockResolvedValue(created)
    const repo = makeRepo({ listActive: async () => [], add })
    const result = await addTrackToPlaylist(
      { trackId: "t-new" as TrackId },
      { playlistItems: repo }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.id).toBe("pi-new")
    expect(add).toHaveBeenCalledWith("t-new")
  })

  it("returns already-in-playlist for active duplicates", async () => {
    const add = vi.fn<IPlaylistItemRepository["add"]>()
    const repo = makeRepo({
      listActive: async () => [sample({ trackId: "t-dup" as TrackId })],
      add,
    })
    const result = await addTrackToPlaylist(
      { trackId: "t-dup" as TrackId },
      { playlistItems: repo }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("already-in-playlist")
    expect(add).not.toHaveBeenCalled()
  })
})

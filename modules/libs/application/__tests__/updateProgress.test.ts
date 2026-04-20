import { describe, expect, it, vi } from "vitest"
import { updateProgress } from "../updateProgress.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"

const noopUnitOfWork: IUnitOfWork = { run: async (fn) => fn() }

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

const sampleItem = (over: Partial<PlaylistItem> = {}): PlaylistItem => ({
  id: "pi-1" as PlaylistItemId,
  trackId: "t-1" as TrackId,
  addedAt: 1000,
  completedAt: null,
  archivedAt: null,
  progress: null,
  ...over,
})

describe("updateProgress", () => {
  it("persists the new position when the item exists", async () => {
    const updateProgressSpy = vi
      .fn<IPlaylistItemRepository["updateProgress"]>()
      .mockResolvedValue(undefined)
    const repo = makeRepo({
      getById: async () => sampleItem(),
      updateProgress: updateProgressSpy,
    })
    const result = await updateProgress(
      { itemId: "pi-1" as PlaylistItemId, progressMs: 42_000 },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(true)
    expect(updateProgressSpy).toHaveBeenCalledWith("pi-1", 42_000)
  })

  it("returns not-found when the item is absent", async () => {
    const repo = makeRepo({ getById: async () => null })
    const result = await updateProgress(
      { itemId: "pi-missing" as PlaylistItemId, progressMs: 1000 },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("not-found")
  })

  it("rejects negative or non-finite progress before hitting the repo", async () => {
    const updateProgressSpy = vi.fn<IPlaylistItemRepository["updateProgress"]>()
    const repo = makeRepo({ updateProgress: updateProgressSpy })
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await updateProgress(
        { itemId: "pi-1" as PlaylistItemId, progressMs: bad },
        { playlistItems: repo, unitOfWork: noopUnitOfWork }
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe("invalid-progress")
    }
    expect(updateProgressSpy).not.toHaveBeenCalled()
  })
})

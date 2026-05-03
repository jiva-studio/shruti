import { describe, expect, it, vi } from "vitest"
import { markCompleted } from "../markCompleted.js"
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

describe("markCompleted", () => {
  it("marks an unfinished item as completed", async () => {
    const markSpy = vi
      .fn<IPlaylistItemRepository["markCompleted"]>()
      .mockResolvedValue(undefined)
    const repo = makeRepo({
      getById: async () => sampleItem(),
      markCompleted: markSpy,
    })
    const result = await markCompleted(
      { itemId: "pi-1" as PlaylistItemId },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(true)
    expect(markSpy).toHaveBeenCalledWith("pi-1")
  })

  it("returns not-found when the item is absent", async () => {
    const repo = makeRepo({ getById: async () => null })
    const result = await markCompleted(
      { itemId: "pi-missing" as PlaylistItemId },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("not-found")
  })

  it("returns already-completed and skips the write when completedAt is set", async () => {
    const markSpy = vi.fn<IPlaylistItemRepository["markCompleted"]>()
    const repo = makeRepo({
      getById: async () => sampleItem({ completedAt: 5000 }),
      markCompleted: markSpy,
    })
    const result = await markCompleted(
      { itemId: "pi-1" as PlaylistItemId },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("already-completed")
    expect(markSpy).not.toHaveBeenCalled()
  })
})

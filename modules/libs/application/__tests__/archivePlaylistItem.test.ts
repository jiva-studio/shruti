import { describe, expect, it, vi } from "vitest"
import { archivePlaylistItem } from "../archivePlaylistItem.js"
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
  archivedAt: null,
  ...over,
})

describe("archivePlaylistItem", () => {
  it("archives an active item and returns ok", async () => {
    const archive = vi.fn<IPlaylistItemRepository["archive"]>().mockResolvedValue(undefined)
    const repo = makeRepo({
      getById: async () => sampleItem(),
      archive,
    })
    const result = await archivePlaylistItem(
      { itemId: "pi-1" as PlaylistItemId },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(true)
    expect(archive).toHaveBeenCalledWith("pi-1")
  })

  it("returns not-found when the item is absent", async () => {
    const repo = makeRepo({ getById: async () => null })
    const result = await archivePlaylistItem(
      { itemId: "pi-missing" as PlaylistItemId },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("not-found")
  })

  it("returns already-archived when archivedAt is set", async () => {
    const archive = vi.fn<IPlaylistItemRepository["archive"]>()
    const repo = makeRepo({
      getById: async () => sampleItem({ archivedAt: 5000 }),
      archive,
    })
    const result = await archivePlaylistItem(
      { itemId: "pi-1" as PlaylistItemId },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("already-archived")
    expect(archive).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from "vitest"
import { addTrackToPlaylist } from "../addTrackToPlaylist.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"

/** Hands the callback a transaction handle, like a real unit of work, so a
 *  test can pin that the use case threads it down to the repository. */
const TX = { kind: "transaction" } as const
const noopUnitOfWork: IUnitOfWork = { run: async (fn) => fn(TX) }

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

const sample = (over: Partial<PlaylistItem> = {}): PlaylistItem => ({
  id: "pi-1" as PlaylistItemId,
  trackId: "t-1" as TrackId,
  addedAt: 1000,
  archivedAt: null,
  collectionId: null,
  ...over,
})

describe("addTrackToPlaylist", () => {
  it("adds when the track is not already active", async () => {
    const created = sample({ id: "pi-new" as PlaylistItemId, trackId: "t-new" as TrackId })
    const add = vi.fn<IPlaylistItemRepository["add"]>().mockResolvedValue(created)
    const repo = makeRepo({ listActive: async () => [], add })
    const result = await addTrackToPlaylist(
      { trackId: "t-new" as TrackId },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.id).toBe("pi-new")
    expect(add).toHaveBeenCalledWith("t-new", null, TX)
  })

  it("forwards the source collectionId to the repo", async () => {
    const created = sample({ trackId: "t-new" as TrackId, collectionId: "col-1" })
    const add = vi.fn<IPlaylistItemRepository["add"]>().mockResolvedValue(created)
    const repo = makeRepo({ listActive: async () => [], add })
    await addTrackToPlaylist(
      { trackId: "t-new" as TrackId, collectionId: "col-1" },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(add).toHaveBeenCalledWith("t-new", "col-1", TX)
  })

  it("returns already-in-playlist for active duplicates", async () => {
    const add = vi.fn<IPlaylistItemRepository["add"]>()
    const repo = makeRepo({
      listActive: async () => [sample({ trackId: "t-dup" as TrackId })],
      add,
    })
    const result = await addTrackToPlaylist(
      { trackId: "t-dup" as TrackId },
      { playlistItems: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("already-in-playlist")
    expect(add).not.toHaveBeenCalled()
  })

  it("runs the listActive+add pair inside the unit-of-work for atomicity", async () => {
    const order: string[] = []
    const created = sample({ id: "pi-new" as PlaylistItemId, trackId: "t-new" as TrackId })
    const add = vi.fn<IPlaylistItemRepository["add"]>().mockImplementation(async (id) => {
      order.push(`add(${id})`)
      return created
    })
    const repo = makeRepo({
      listActive: async () => {
        order.push("listActive")
        return []
      },
      add,
    })
    const uow: IUnitOfWork = {
      run: async (fn) => {
        order.push("uow:start")
        const r = await fn()
        order.push("uow:end")
        return r
      },
    }
    await addTrackToPlaylist(
      { trackId: "t-new" as TrackId },
      { playlistItems: repo, unitOfWork: uow }
    )
    expect(order).toEqual(["uow:start", "listActive", "add(t-new)", "uow:end"])
  })
})

import { describe, expect, it, vi } from "vitest"
import { removeDownloadedMedia } from "../removeDownloadedMedia.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { MediaItem } from "@lib/domain/mediaItem.js"
import type { MediaItemId, TrackId } from "@lib/domain/core.js"

function makeRepo(overrides: Partial<IMediaItemRepository> = {}): IMediaItemRepository {
  return {
    getByTrack: async () => null,
    listReady: async () => [],
    upsert: async () => {
      throw new Error("upsert not stubbed")
    },
    deleteByTrack: async () => {},
    deleteById: async () => {},
    clearAll: async () => {},
    failStaleDownloads: async () => {},
    ...overrides,
  }
}

const existing: MediaItem = {
  id: "mi-1" as MediaItemId,
  trackId: "t-1" as TrackId,
  state: "ready",
  localPath: "blob:local/1",
  createdAt: 1000,
}

describe("removeDownloadedMedia", () => {
  it("demotes the row, deletes local bytes, then drops the record", async () => {
    const calls: string[] = []
    const deleteLocal = vi
      .fn<(url: string) => Promise<void>>()
      .mockImplementation(async () => {
        calls.push("deleteLocal")
      })
    const upsert = vi
      .fn<IMediaItemRepository["upsert"]>()
      .mockImplementation(async (trackId, state, localPath) => {
        calls.push(`upsert(${state})`)
        return {
          id: "mi-1" as MediaItemId,
          trackId: trackId as TrackId,
          state,
          localPath,
          createdAt: 1000,
        }
      })
    const deleteByTrack = vi
      .fn<IMediaItemRepository["deleteByTrack"]>()
      .mockImplementation(async () => {
        calls.push("deleteByTrack")
      })
    const repo = makeRepo({ getByTrack: async () => existing, upsert, deleteByTrack })
    const result = await removeDownloadedMedia(
      { trackId: "t-1" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      { mediaItems: repo, deleteLocal }
    )
    expect(result.ok).toBe(true)
    expect(calls).toEqual(["upsert(failed)", "deleteLocal", "deleteByTrack"])
    expect(deleteLocal).toHaveBeenCalledWith("https://cdn/file.mp3")
    expect(deleteByTrack).toHaveBeenCalledWith("t-1")
  })

  it("returns not-downloaded when nothing is cached", async () => {
    const deleteLocal = vi.fn<(url: string) => Promise<void>>()
    const repo = makeRepo({ getByTrack: async () => null })
    const result = await removeDownloadedMedia(
      { trackId: "t-missing" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      { mediaItems: repo, deleteLocal }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("not-downloaded")
    expect(deleteLocal).not.toHaveBeenCalled()
  })

  it("still drops the row when the file delete throws (orphan-file tolerance)", async () => {
    const deleteLocal = vi
      .fn<(url: string) => Promise<void>>()
      .mockRejectedValue(new Error("permission denied"))
    const deleteByTrack = vi
      .fn<IMediaItemRepository["deleteByTrack"]>()
      .mockResolvedValue(undefined)
    const upsert = vi
      .fn<IMediaItemRepository["upsert"]>()
      .mockImplementation(async (trackId, state, localPath) => ({
        id: "mi-1" as MediaItemId,
        trackId: trackId as TrackId,
        state,
        localPath,
        createdAt: 1000,
      }))
    const repo = makeRepo({ getByTrack: async () => existing, upsert, deleteByTrack })
    const result = await removeDownloadedMedia(
      { trackId: "t-1" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      { mediaItems: repo, deleteLocal }
    )
    expect(result.ok).toBe(true)
    expect(deleteByTrack).toHaveBeenCalledWith("t-1")
  })

  it("skips re-marking when the row is already failed with no localPath (idempotent retry)", async () => {
    const failedRow: MediaItem = {
      id: "mi-1" as MediaItemId,
      trackId: "t-1" as TrackId,
      state: "failed",
      localPath: null,
      createdAt: 1000,
    }
    const upsert = vi.fn<IMediaItemRepository["upsert"]>()
    const deleteLocal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
    const deleteByTrack = vi
      .fn<IMediaItemRepository["deleteByTrack"]>()
      .mockResolvedValue(undefined)
    const repo = makeRepo({ getByTrack: async () => failedRow, upsert, deleteByTrack })
    const result = await removeDownloadedMedia(
      { trackId: "t-1" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      { mediaItems: repo, deleteLocal }
    )
    expect(result.ok).toBe(true)
    expect(upsert).not.toHaveBeenCalled()
    expect(deleteLocal).toHaveBeenCalled()
    expect(deleteByTrack).toHaveBeenCalledWith("t-1")
  })
})

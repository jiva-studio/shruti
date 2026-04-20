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
  it("deletes local bytes and clears the media-item record", async () => {
    const deleteLocal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
    const deleteByTrack = vi
      .fn<IMediaItemRepository["deleteByTrack"]>()
      .mockResolvedValue(undefined)
    const repo = makeRepo({ getByTrack: async () => existing, deleteByTrack })
    const result = await removeDownloadedMedia(
      { trackId: "t-1" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      { mediaItems: repo, deleteLocal }
    )
    expect(result.ok).toBe(true)
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
})

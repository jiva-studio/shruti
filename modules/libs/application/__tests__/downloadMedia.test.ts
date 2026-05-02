import { describe, expect, it, vi } from "vitest"
import { downloadMedia } from "../downloadMedia.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { MediaItem, MediaItemState } from "@lib/domain/mediaItem.js"
import type { MediaItemId, TrackId } from "@lib/domain/core.js"

function makeRepo(overrides: Partial<IMediaItemRepository> = {}): IMediaItemRepository {
  return {
    getByTrack: async () => null,
    listReady: async () => [],
    upsert: async (trackId, state, localPath) => ({
      id: `mi-${trackId}` as MediaItemId,
      trackId: trackId as TrackId,
      state,
      localPath,
      createdAt: 1000,
    }),
    deleteByTrack: async () => {},
    deleteById: async () => {},
    clearAll: async () => {},
    ...overrides,
  }
}

const existingItem = (state: MediaItemState, localPath: string | null = null): MediaItem => ({
  id: "mi-1" as MediaItemId,
  trackId: "t-1" as TrackId,
  state,
  localPath,
  createdAt: 500,
})

describe("downloadMedia", () => {
  it("transfers and persists ready + localPath on success", async () => {
    const upsert = vi
      .fn<IMediaItemRepository["upsert"]>()
      .mockImplementation(async (trackId, state, localPath) => ({
        id: "mi-new" as MediaItemId,
        trackId: trackId as TrackId,
        state,
        localPath,
        createdAt: 1000,
      }))
    const repo = makeRepo({ upsert })
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      { mediaItems: repo, transfer: async () => "blob:local/1" }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.state).toBe("ready")
      expect(result.value.localPath).toBe("blob:local/1")
    }
    expect(upsert).toHaveBeenNthCalledWith(1, "t-1", "downloading", null)
    expect(upsert).toHaveBeenNthCalledWith(2, "t-1", "ready", "blob:local/1")
  })

  it("short-circuits when the track is already ready with a localPath", async () => {
    const transfer = vi.fn<(url: string) => Promise<string>>()
    const upsert = vi.fn<IMediaItemRepository["upsert"]>()
    const repo = makeRepo({
      getByTrack: async () => existingItem("ready", "blob:cached"),
      upsert,
    })
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      { mediaItems: repo, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.localPath).toBe("blob:cached")
    expect(transfer).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it("returns already-in-progress when a download is mid-flight", async () => {
    const transfer = vi.fn<(url: string) => Promise<string>>()
    const repo = makeRepo({ getByTrack: async () => existingItem("downloading") })
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      { mediaItems: repo, transfer }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("already-in-progress")
    expect(transfer).not.toHaveBeenCalled()
  })

  it("records failed state and returns transfer-failed on transfer throw", async () => {
    const upsert = vi.fn<IMediaItemRepository["upsert"]>().mockImplementation(
      async (trackId, state, localPath) => ({
        id: "mi-1" as MediaItemId,
        trackId: trackId as TrackId,
        state,
        localPath,
        createdAt: 1000,
      })
    )
    const repo = makeRepo({ upsert })
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      {
        mediaItems: repo,
        transfer: async () => {
          throw new Error("network")
        },
      }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("transfer-failed")
    expect(upsert).toHaveBeenNthCalledWith(2, "t-1", "failed", null)
  })

  it("returns persist-failed when post-transfer upsert throws", async () => {
    const upsert = vi
      .fn<IMediaItemRepository["upsert"]>()
      .mockImplementationOnce(async (trackId, state, localPath) => ({
        id: "mi-1" as MediaItemId,
        trackId: trackId as TrackId,
        state,
        localPath,
        createdAt: 1000,
      }))
      .mockImplementationOnce(async () => {
        throw new Error("disk full")
      })
    const repo = makeRepo({ upsert })
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      { mediaItems: repo, transfer: async () => "blob:local/1" }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("persist-failed")
    // First upsert sets "downloading"; the failing one is the "ready" write.
    // Crucially, no third "failed" upsert — bytes are on disk and we don't
    // want to lie about that on retry.
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenNthCalledWith(1, "t-1", "downloading", null)
    expect(upsert).toHaveBeenNthCalledWith(2, "t-1", "ready", "blob:local/1")
  })

  it("still returns transfer-failed when the failed-marker upsert also throws", async () => {
    const upsert = vi
      .fn<IMediaItemRepository["upsert"]>()
      .mockImplementationOnce(async (trackId, state, localPath) => ({
        id: "mi-1" as MediaItemId,
        trackId: trackId as TrackId,
        state,
        localPath,
        createdAt: 1000,
      }))
      .mockImplementationOnce(async () => {
        throw new Error("db locked")
      })
    const repo = makeRepo({ upsert })
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, remoteUrl: "https://cdn/file.mp3" },
      {
        mediaItems: repo,
        transfer: async () => {
          throw new Error("network")
        },
      }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("transfer-failed")
  })
})

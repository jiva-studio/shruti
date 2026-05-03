import { describe, expect, it, vi } from "vitest"
import { downloadMedia } from "../downloadMedia.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { MediaItem, MediaItemState } from "@lib/domain/mediaItem.js"
import type { MediaItemId, TrackId } from "@lib/domain/core.js"
import type { CdnServer } from "@lib/domain/servers.js"

const SERVER_A: CdnServer = {
  id: "server-a",
  name: "Server A",
  urlTemplate: "https://a.example.com/{path}",
}
const SERVER_B: CdnServer = {
  id: "server-b",
  name: "Server B",
  urlTemplate: "https://b.example.com/{path}",
}

const PATH = "public/tracks/t-1/audio/original.mp3"

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
    failStaleDownloads: async () => {},
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
  it("transfers via the first candidate and reports its server on success", async () => {
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
    const transfer = vi
      .fn<(url: string) => Promise<string>>()
      .mockResolvedValue("blob:local/1")
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B] },
      { mediaItems: repo, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.mediaItem.state).toBe("ready")
      expect(result.value.mediaItem.localPath).toBe("blob:local/1")
      expect(result.value.server).toEqual(SERVER_A)
    }
    expect(transfer).toHaveBeenCalledTimes(1)
    expect(transfer).toHaveBeenCalledWith(`https://a.example.com/${PATH}`, expect.any(Function))
    expect(upsert).toHaveBeenNthCalledWith(1, "t-1", "downloading", null)
    expect(upsert).toHaveBeenNthCalledWith(2, "t-1", "ready", "blob:local/1")
  })

  it("falls back to the next candidate when the active server's transfer throws", async () => {
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
    const transfer = vi
      .fn<(url: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("CDN A is degraded"))
      .mockResolvedValueOnce("blob:local/from-b")
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B] },
      { mediaItems: repo, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.server).toEqual(SERVER_B)
      expect(result.value.mediaItem.localPath).toBe("blob:local/from-b")
    }
    expect(transfer).toHaveBeenNthCalledWith(1, `https://a.example.com/${PATH}`, expect.any(Function))
    expect(transfer).toHaveBeenNthCalledWith(2, `https://b.example.com/${PATH}`, expect.any(Function))
    // Crucially we did NOT mark the row "failed" between attempts —
    // the second candidate succeeded, so the user never sees a flash
    // of failed UI.
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenNthCalledWith(1, "t-1", "downloading", null)
    expect(upsert).toHaveBeenNthCalledWith(2, "t-1", "ready", "blob:local/from-b")
  })

  it("returns transfer-failed only after every candidate is exhausted", async () => {
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
    const transfer = vi
      .fn<(url: string) => Promise<string>>()
      .mockRejectedValue(new Error("network"))
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B] },
      { mediaItems: repo, transfer }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("transfer-failed")
    expect(transfer).toHaveBeenCalledTimes(2)
    // Both candidates were tried before we gave up.
    expect(transfer).toHaveBeenNthCalledWith(1, `https://a.example.com/${PATH}`, expect.any(Function))
    expect(transfer).toHaveBeenNthCalledWith(2, `https://b.example.com/${PATH}`, expect.any(Function))
    expect(upsert).toHaveBeenNthCalledWith(2, "t-1", "failed", null)
  })

  it("returns no-candidates when the candidate list is empty", async () => {
    const transfer = vi.fn<(url: string) => Promise<string>>()
    const repo = makeRepo()
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [] },
      { mediaItems: repo, transfer }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("no-candidates")
    expect(transfer).not.toHaveBeenCalled()
  })

  it("short-circuits when the track is already ready with a localPath", async () => {
    const transfer = vi.fn<(url: string) => Promise<string>>()
    const upsert = vi.fn<IMediaItemRepository["upsert"]>()
    const repo = makeRepo({
      getByTrack: async () => existingItem("ready", "blob:cached"),
      upsert,
    })
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B] },
      { mediaItems: repo, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.mediaItem.localPath).toBe("blob:cached")
      // No transfer happened — we attribute the (already-cached) bytes
      // to the active server (first candidate). The download store
      // checks `success.server.id === activeServer.id` before promoting
      // and treats this as a no-op.
      expect(result.value.server).toEqual(SERVER_A)
    }
    expect(transfer).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it("returns already-in-progress when a download is mid-flight", async () => {
    const transfer = vi.fn<(url: string) => Promise<string>>()
    const repo = makeRepo({ getByTrack: async () => existingItem("downloading") })
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A] },
      { mediaItems: repo, transfer }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("already-in-progress")
    expect(transfer).not.toHaveBeenCalled()
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
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A] },
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
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A] },
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

  it("forwards progress only for the candidate currently transferring", async () => {
    const repo = makeRepo()
    const onProgress = vi.fn<(pct: number) => void>()
    // First candidate fails after partial progress; second succeeds.
    const transfer = vi
      .fn<(url: string, cb?: (received: number, total: number) => void) => Promise<string>>()
      .mockImplementationOnce(async (_url, cb) => {
        cb?.(50, 100) // 50% on first candidate
        throw new Error("disconnected")
      })
      .mockImplementationOnce(async (_url, cb) => {
        cb?.(100, 100)
        return "blob:local/from-b"
      })
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B] },
      { mediaItems: repo, transfer },
      onProgress
    )
    expect(result.ok).toBe(true)
    // After the first candidate failed we reset progress to 0 so the
    // radial gauge doesn't display the dead server's last sample while
    // we re-establish from byte 0 elsewhere.
    expect(onProgress).toHaveBeenCalledWith(50)
    expect(onProgress).toHaveBeenCalledWith(0)
    expect(onProgress).toHaveBeenLastCalledWith(100)
  })
})

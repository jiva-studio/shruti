import { afterEach, describe, expect, it, vi } from "vitest"
import { downloadMedia, HEDGE_CEILING_MS, HEDGE_INTERVAL_MS } from "../downloadMedia.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { MediaItem, MediaItemState } from "@lib/domain/mediaItem.js"
import type { MediaItemId, TrackId } from "@lib/domain/core.js"
import type { CdnServer } from "@lib/domain/servers.js"

const noopUnitOfWork: IUnitOfWork = { run: async (fn) => fn() }

const SERVER_A: CdnServer = {
  id: "server-a",
  name: "Server A",
  urlTemplate: "https://a.example.com/{path}",
  shareAudioUrl: "https://a.example.com/excerpts",
  shareVideoUrl: "https://a.example.com/reels",
  authBaseUrl: "https://a.example.com/auth",
  chatBaseUrl: "https://a.example.com",
}
const SERVER_B: CdnServer = {
  id: "server-b",
  name: "Server B",
  urlTemplate: "https://b.example.com/{path}",
  shareAudioUrl: "https://b.example.com/excerpts",
  shareVideoUrl: "https://b.example.com/reels",
  authBaseUrl: "https://b.example.com/auth",
  chatBaseUrl: "https://b.example.com",
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
    markEvictPending: async () => {},
    listEvictPending: async () => [],
    deleteByTrack: async () => {},
    deleteById: async () => {},
    clearAll: async () => {},
    failStaleDownloads: async () => {},
    ...overrides,
  }
}

/** An `upsert` that always hands back the same row id, so the claim is identifiable. */
function claimAs(id: string) {
  return vi
    .fn<IMediaItemRepository["upsert"]>()
    .mockImplementation(async (trackId, state, localPath) => ({
      id: id as MediaItemId,
      trackId: trackId as TrackId,
      state,
      localPath,
      createdAt: 1000,
    }))
}

/**
 * What the adapter throws when a transfer was cancelled. `reason` is the
 * whole point: "user" ends the download, "superseded" is a losing candidate
 * being dropped and must stay invisible.
 */
function cancellation(reason: "user" | "superseded" = "user"): Error {
  const e = new Error("Download cancelled") as Error & { reason: string }
  e.name = "DownloadCancelledError"
  e.reason = reason
  return e
}

/**
 * A transfer that answers only when the test says so. `deliver` reports a
 * byte (which is what wins the race) and resolves; `fail` rejects. An
 * untouched one stays silent forever — a dead region.
 */
function controllable() {
  const attempts: {
    url: string
    signal?: AbortSignal
    /** Report bytes without finishing — this is what wins the race. */
    report: (received: number, total: number) => void
    deliver: (localUrl?: string) => void
    fail: (e: unknown) => void
  }[] = []
  const transfer = vi.fn(
    (
      url: string,
      onProgress?: (received: number, total: number) => void,
      signal?: AbortSignal
    ): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        const attempt = {
          url,
          signal,
          report: (received: number, total: number) => onProgress?.(received, total),
          deliver: (localUrl = `blob:${url}`) => {
            onProgress?.(50, 100)
            resolve(localUrl)
          },
          fail: reject,
        }
        attempts.push(attempt)
        // The adapter turns an abort into a superseded cancellation; the
        // fake has to do the same or the loop under test never sees one.
        signal?.addEventListener("abort", () => reject(cancellation("superseded")), { once: true })
      })
  )
  return { transfer, attempts }
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
    const transfer = vi.fn<(url: string) => Promise<string>>().mockResolvedValue("blob:local/1")
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B] },
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.mediaItem.state).toBe("ready")
      expect(result.value.mediaItem.localPath).toBe("blob:local/1")
      expect(result.value.server).toEqual(SERVER_A)
    }
    expect(transfer).toHaveBeenCalledTimes(1)
    expect(transfer).toHaveBeenCalledWith(
      `https://a.example.com/${PATH}`,
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(upsert).toHaveBeenNthCalledWith(1, "t-1", "downloading", null, "original")
    expect(upsert).toHaveBeenNthCalledWith(2, "t-1", "ready", "blob:local/1", "original")
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
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.server).toEqual(SERVER_B)
      expect(result.value.mediaItem.localPath).toBe("blob:local/from-b")
    }
    expect(transfer).toHaveBeenNthCalledWith(
      1,
      `https://a.example.com/${PATH}`,
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(transfer).toHaveBeenNthCalledWith(
      2,
      `https://b.example.com/${PATH}`,
      expect.any(Function),
      expect.any(AbortSignal)
    )
    // Crucially we did NOT mark the row "failed" between attempts —
    // the second candidate succeeded, so the user never sees a flash
    // of failed UI.
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenNthCalledWith(1, "t-1", "downloading", null, "original")
    expect(upsert).toHaveBeenNthCalledWith(2, "t-1", "ready", "blob:local/from-b", "original")
  })

  it("returns transfer-failed only after every candidate is exhausted", async () => {
    const upsert = vi
      .fn<IMediaItemRepository["upsert"]>()
      .mockImplementation(async (trackId, state, localPath) => ({
        id: "mi-1" as MediaItemId,
        trackId: trackId as TrackId,
        state,
        localPath,
        createdAt: 1000,
      }))
    const repo = makeRepo({ upsert })
    const transfer = vi
      .fn<(url: string) => Promise<string>>()
      .mockRejectedValue(new Error("network"))
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B] },
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("transfer-failed")
    expect(transfer).toHaveBeenCalledTimes(2)
    // Both candidates were tried before we gave up.
    expect(transfer).toHaveBeenNthCalledWith(
      1,
      `https://a.example.com/${PATH}`,
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(transfer).toHaveBeenNthCalledWith(
      2,
      `https://b.example.com/${PATH}`,
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(upsert).toHaveBeenNthCalledWith(2, "t-1", "failed", null, "original")
  })

  it("stops at the cancelled candidate instead of re-downloading from the next", async () => {
    const deleteById = vi.fn<IMediaItemRepository["deleteById"]>()
    // Nothing on disk when we claim the slot; afterwards the read sees the
    // very row this call claimed (same id).
    const getByTrack = vi
      .fn<IMediaItemRepository["getByTrack"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(existingItem("downloading"))
    const repo = makeRepo({ getByTrack, deleteById, upsert: claimAs("mi-1") })
    const transfer = vi.fn<(url: string) => Promise<string>>().mockRejectedValue(cancellation())
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B] },
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("cancelled")
    // The user asked us to stop — trying server B would fetch the very
    // bytes the cancel was meant to save.
    expect(transfer).toHaveBeenCalledTimes(1)
    // The claimed "downloading" row is released, so a later tap can retry.
    expect(deleteById).toHaveBeenCalledWith("mi-1")
  })

  it("leaves no row behind when the cancel came from a remove that already deleted it", async () => {
    const deleteById = vi.fn<IMediaItemRepository["deleteById"]>()
    const upsert = claimAs("mi-1")
    // `remove()` deletes the track's rows while the cancellation is in
    // flight, so the post-cancel read finds nothing.
    const repo = makeRepo({ getByTrack: async () => null, deleteById, upsert })
    const transfer = vi.fn<(url: string) => Promise<string>>().mockRejectedValue(cancellation())
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A] },
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("cancelled")
    expect(deleteById).not.toHaveBeenCalled()
    // Only the initial claim — nothing writes the row back after the delete.
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledWith("t-1", "downloading", null, "original")
  })

  it("does not release a claim that belongs to a newer task", async () => {
    const deleteById = vi.fn<IMediaItemRepository["deleteById"]>()
    // Our claim is wiped and a newer task claims its own row for the same
    // track; deleting that one would strip its already-in-progress guard.
    const getByTrack = vi
      .fn<IMediaItemRepository["getByTrack"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ...existingItem("downloading"), id: "mi-newer" as MediaItemId })
    const repo = makeRepo({ getByTrack, deleteById, upsert: claimAs("mi-1") })
    const transfer = vi.fn<(url: string) => Promise<string>>().mockRejectedValue(cancellation())
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A] },
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer }
    )
    expect(result.ok).toBe(false)
    expect(deleteById).not.toHaveBeenCalled()
  })

  it("returns no-candidates when the candidate list is empty", async () => {
    const transfer = vi.fn<(url: string) => Promise<string>>()
    const repo = makeRepo()
    const result = await downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [] },
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer }
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
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer }
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
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("already-in-progress")
    expect(transfer).not.toHaveBeenCalled()
  })

  it("serialises concurrent claims through the unit of work — only one transfer fires", async () => {
    // Serialising UoW: every run() waits for the previous one to finish.
    // Mirrors SQLite's exclusive transaction semantics.
    let queue: Promise<unknown> = Promise.resolve()
    const serialUoW: IUnitOfWork = {
      run: <T>(fn: () => Promise<T>): Promise<T> => {
        const next = queue.then(fn) as Promise<T>
        queue = next.catch(() => undefined)
        return next
      },
    }
    let state: MediaItemState | null = null
    const repo = makeRepo({
      getByTrack: async () =>
        state === null
          ? null
          : { ...existingItem(state, state === "ready" ? "blob:cached" : null) },
      upsert: async (trackId, nextState, localPath) => {
        state = nextState
        return {
          id: "mi-1" as MediaItemId,
          trackId: trackId as TrackId,
          state: nextState,
          localPath,
          createdAt: 1000,
        }
      },
    })
    const transfer = vi.fn<(url: string) => Promise<string>>().mockResolvedValue("blob:local/1")

    const [first, second] = await Promise.all([
      downloadMedia(
        { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A] },
        { mediaItems: repo, unitOfWork: serialUoW, transfer }
      ),
      downloadMedia(
        { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A] },
        { mediaItems: repo, unitOfWork: serialUoW, transfer }
      ),
    ])

    // Exactly one call performed the byte transfer; the other returned
    // already-in-progress without re-downloading.
    expect(transfer).toHaveBeenCalledTimes(1)
    const outcomes = [first.ok, second.ok].sort()
    expect(outcomes).toEqual([false, true])
    const failed = first.ok ? second : first
    if (!failed.ok) expect(failed.error).toBe("already-in-progress")
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
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer: async () => "blob:local/1" }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("persist-failed")
    // First upsert sets "downloading"; the failing one is the "ready" write.
    // Crucially, no third "failed" upsert — bytes are on disk and we don't
    // want to lie about that on retry.
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenNthCalledWith(1, "t-1", "downloading", null, "original")
    expect(upsert).toHaveBeenNthCalledWith(2, "t-1", "ready", "blob:local/1", "original")
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
        unitOfWork: noopUnitOfWork,
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
      { mediaItems: repo, unitOfWork: noopUnitOfWork, transfer },
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

const SERVER_C: CdnServer = {
  id: "server-c",
  name: "Server C",
  urlTemplate: "https://c.example.com/{path}",
  shareAudioUrl: "https://c.example.com/excerpts",
  shareVideoUrl: "https://c.example.com/reels",
  authBaseUrl: "https://c.example.com/auth",
  chatBaseUrl: "https://c.example.com",
}

describe("downloadMedia — hedged candidates", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("starts the next candidate alongside a silent one instead of waiting it out", async () => {
    vi.useFakeTimers()
    const { transfer, attempts } = controllable()
    const pending = downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B, SERVER_C] },
      { mediaItems: makeRepo(), unitOfWork: noopUnitOfWork, transfer }
    )
    await vi.waitFor(() => expect(attempts).toHaveLength(1))

    // A is connected but silent. It is NOT cancelled — slow to answer is not
    // dead — and B joins it.
    await vi.advanceTimersByTimeAsync(HEDGE_INTERVAL_MS)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(HEDGE_INTERVAL_MS)
    expect(attempts).toHaveLength(3)

    attempts[1]!.deliver("blob:from-b")
    const result = await pending
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.server).toEqual(SERVER_B)
  })

  it("cancels every other candidate the moment one delivers bytes", async () => {
    vi.useFakeTimers()
    const { transfer, attempts } = controllable()
    const pending = downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B, SERVER_C] },
      { mediaItems: makeRepo(), unitOfWork: noopUnitOfWork, transfer }
    )
    await vi.advanceTimersByTimeAsync(HEDGE_INTERVAL_MS * 2)
    expect(attempts).toHaveLength(3)

    attempts[2]!.deliver("blob:from-c")
    await pending

    // Both losers are aborted — the whole point is that they stop before
    // writing a byte, since all three share one destination on disk.
    expect(attempts[0]!.signal?.aborted).toBe(true)
    expect(attempts[1]!.signal?.aborted).toBe(true)
    expect(attempts[2]!.signal?.aborted).toBe(false)
    // And no further candidate is dragged in behind the winner.
    await vi.advanceTimersByTimeAsync(HEDGE_INTERVAL_MS * 3)
    expect(transfer).toHaveBeenCalledTimes(3)
  })

  it("a dropped loser surfaces nothing and does not advance the walk", async () => {
    vi.useFakeTimers()
    const { transfer, attempts } = controllable()
    const upsert = claimAs("mi-1")
    const pending = downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B, SERVER_C] },
      { mediaItems: makeRepo({ upsert }), unitOfWork: noopUnitOfWork, transfer }
    )
    await vi.advanceTimersByTimeAsync(HEDGE_INTERVAL_MS)
    expect(attempts).toHaveLength(2)

    attempts[0]!.deliver("blob:from-a")
    // B now rejects as a superseded loser. That must not read as a failure
    // (no "failed" row, no toast) and must not pull C in.
    await vi.advanceTimersByTimeAsync(HEDGE_INTERVAL_MS * 3)

    const result = await pending
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.server).toEqual(SERVER_A)
    expect(transfer).toHaveBeenCalledTimes(2)
    expect(upsert).not.toHaveBeenCalledWith("t-1", "failed", null, "original")
  })

  it("a user cancel stops the loop instead of advancing to the next region", async () => {
    vi.useFakeTimers()
    const { transfer, attempts } = controllable()
    const deleteById = vi.fn<IMediaItemRepository["deleteById"]>()
    const getByTrack = vi
      .fn<IMediaItemRepository["getByTrack"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(existingItem("downloading"))
    const pending = downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B, SERVER_C] },
      {
        mediaItems: makeRepo({ getByTrack, deleteById, upsert: claimAs("mi-1") }),
        unitOfWork: noopUnitOfWork,
        transfer,
      }
    )
    await vi.advanceTimersByTimeAsync(HEDGE_INTERVAL_MS)
    expect(attempts).toHaveLength(2)

    // The user removed the track: the downloader aborts every live attempt
    // and tags them "user".
    attempts[0]!.fail(cancellation("user"))
    attempts[1]!.fail(cancellation("user"))
    await vi.advanceTimersByTimeAsync(HEDGE_CEILING_MS)

    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("cancelled")
    // C was never started — trying it would fetch the very bytes the cancel
    // was meant to save.
    expect(transfer).toHaveBeenCalledTimes(2)
    expect(deleteById).toHaveBeenCalledWith("mi-1")
  })

  it("fails once when nothing has delivered by the ceiling", async () => {
    vi.useFakeTimers()
    const { transfer, attempts } = controllable()
    const upsert = claimAs("mi-1")
    const pending = downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B, SERVER_C] },
      { mediaItems: makeRepo({ upsert }), unitOfWork: noopUnitOfWork, transfer }
    )
    await vi.advanceTimersByTimeAsync(HEDGE_CEILING_MS)

    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("transfer-failed")
    // Every candidate got to try, all three are dropped, and the row is
    // marked failed exactly once — one message for the user, not one per
    // region.
    expect(attempts).toHaveLength(3)
    for (const attempt of attempts) expect(attempt.signal?.aborted).toBe(true)
    const failedWrites = upsert.mock.calls.filter(([, state]) => state === "failed")
    expect(failedWrites).toHaveLength(1)
  })

  it("bounds the whole wait by one ceiling, not one per region", async () => {
    vi.useFakeTimers()
    const started = Date.now()
    const { transfer } = controllable()
    const pending = downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B, SERVER_C] },
      { mediaItems: makeRepo(), unitOfWork: noopUnitOfWork, transfer }
    )
    await vi.advanceTimersByTimeAsync(HEDGE_CEILING_MS)
    await pending
    expect(Date.now() - started).toBeLessThanOrEqual(HEDGE_CEILING_MS)
  })

  it("re-opens the race when the winner dies mid-body", async () => {
    vi.useFakeTimers()
    const { transfer, attempts } = controllable()
    const pending = downloadMedia(
      { trackId: "t-1" as TrackId, path: PATH, candidates: [SERVER_A, SERVER_B] },
      { mediaItems: makeRepo(), unitOfWork: noopUnitOfWork, transfer }
    )
    await vi.waitFor(() => expect(attempts).toHaveLength(1))

    // A wins on first byte, then the connection drops — the in-flight CDN
    // failure the fallback exists for.
    attempts[0]!.report(10, 100)
    attempts[0]!.fail(new Error("connection reset"))
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1]!.deliver("blob:from-b")

    const result = await pending
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.server).toEqual(SERVER_B)
  })
})

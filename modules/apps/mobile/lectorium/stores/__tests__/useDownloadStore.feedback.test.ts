import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { watch } from "vue"
import type { DownloadState } from "../useDownloadStore.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const resolveLocalUrl = vi.fn<(url: string) => Promise<string | null>>()
const deleteFile = vi.fn<(url: string) => Promise<void>>()
const upsert = vi.fn<(id: string, state: string, path: string | null) => Promise<void>>()
const downloadMedia = vi.fn()
const toastError = vi.fn()
/** How an actionable toast ended; mirrors kit's `ToastOutcome`. */
type Outcome = { kind: "pressed"; index: number } | { kind: "expired" } | { kind: "dismissed" }
const toastAction = vi.fn<(message: string, opts: unknown) => Promise<Outcome>>()
const prefetchForTrack = vi.fn()

let hasRoom = true
const reserve = vi.fn()
const settle = vi.fn()

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), action: toastAction }),
}))
vi.mock("@lib/domain/servers.js", () => ({
  buildServerUrl: (_server: unknown, path: string) => `https://cdn.test/${path}`,
}))
vi.mock("@usecases/downloads/downloadMedia.js", () => ({
  downloadMedia: (...args: unknown[]) => downloadMedia(...args),
}))
vi.mock("@usecases/downloads/removeDownloadedMedia.js", () => ({
  removeDownloadedMedia: vi.fn(),
}))
vi.mock("@usecases/downloads/removeDownloadedTranscripts.js", () => ({
  removeDownloadedTranscripts: vi.fn(),
}))
vi.mock("../downloads/useServerFallback.js", () => ({
  useServerFallback: () => ({ candidates: () => [] }),
}))
vi.mock("../downloads/useTranscriptPrefetch.js", () => ({
  useTranscriptPrefetch: () => ({ prefetchForTrack }),
}))
vi.mock("../useDownloadQuotaStore.js", () => ({
  useDownloadQuotaStore: () => ({
    limitBytes: 0,
    isMeasured: true,
    ensureMeasured: () => Promise.resolve(),
    sizeOf: () => 1000,
    hasRoomFor: () => hasRoom,
    reserve,
    settle,
    adopt: vi.fn(),
    uncharge: vi.fn(),
    forget: vi.fn(),
    refresh: () => Promise.resolve(),
    reset: vi.fn(),
  }),
}))
vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    activeServer: { value: { id: "global" } },
    setActiveServer: vi.fn(),
    mediaDownloader: {
      resolveLocalUrl,
      delete: deleteFile,
      download: vi.fn(),
      cancel: vi.fn(() => Promise.resolve()),
    },
    repositories: () => ({
      mediaItems: { upsert, failStaleDownloads: vi.fn(async () => []), listReady: vi.fn() },
      unitOfWork: {},
    }),
  }),
}))

import { useDownloadStore } from "../useDownloadStore.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                  */
/* --------------------------------------------------------------------- */

const TRACK = "track-1"
const PATH = "public/audio/track-1.mp3"

type Store = ReturnType<typeof useDownloadStore>

/** Record every state this track is painted with, in order. */
function trackStates(store: Store): DownloadState[] {
  const seen: DownloadState[] = []
  watch(
    () => store.states.get(TRACK),
    (state) => {
      if (state) seen.push(state)
    },
    { flush: "sync" }
  )
  return seen
}

function online(value: boolean): void {
  vi.stubGlobal("navigator", { onLine: value })
}

/**
 * Let the actionable toast resolve and anything it starts run to the end.
 * The budget notice is deliberately NOT awaited by the download task — the
 * refused call returns `null` at once — so a press lands a whole task later.
 */
async function settleNotice(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("useDownloadStore — tap feedback and failure notices", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    hasRoom = true
    online(true)
    // Nobody presses the button unless a test says so.
    toastAction.mockResolvedValue({ kind: "expired" })
    resolveLocalUrl.mockResolvedValue(null)
    deleteFile.mockResolvedValue(undefined)
    upsert.mockResolvedValue(undefined)
    downloadMedia.mockResolvedValue({
      ok: true,
      value: {
        server: { id: "global" },
        mediaItem: { localPath: "file:///local/track-1.mp3" },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /* ----------------------------- issue #1483 ---------------------------- */

  it("claims `pending` synchronously, before the first await settles", async () => {
    // Hold the cache probe open: the row must already read "pending" while
    // the very first await of the task is still unresolved.
    let releaseProbe: (value: string | null) => void = () => {}
    resolveLocalUrl.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseProbe = resolve
      })
    )
    const store = useDownloadStore()

    const task = store.ensureDownloaded(TRACK, PATH)
    expect(store.getState(TRACK)).toBe("pending")
    await Promise.resolve()
    expect(store.getState(TRACK)).toBe("pending")

    releaseProbe("file:///local/track-1.mp3")
    await task
    expect(store.getState(TRACK)).toBe("completed")
  })

  it("answers a retry tap on a failed row, over its own red X", async () => {
    downloadMedia.mockResolvedValue({ ok: false, error: "all-candidates-failed" })
    const store = useDownloadStore()
    await store.ensureDownloaded(TRACK, PATH)
    expect(store.getState(TRACK)).toBe("failed")

    // The retry goes through `ensureMeasured` and a native delete before it
    // can paint "downloading" — the shimmer is what covers that stretch.
    const retry = store.ensureDownloaded(TRACK, PATH)
    expect(store.getState(TRACK)).toBe("pending")

    await retry
    // Still a retry underneath: the phantom-cache cleanup must not be
    // skipped just because the row now reads "pending".
    expect(deleteFile).toHaveBeenCalledWith(`https://cdn.test/${PATH}`)
    expect(store.getState(TRACK)).toBe("failed")
  })

  it("still takes the retry path when an outer caller claimed the row first", async () => {
    // `openTrack` claims the row before calling in, so the raw state reads
    // "pending" by the time `isRetryAfterFailure` is derived. Reading it
    // raw would silently skip the iOS phantom-cache cleanup.
    downloadMedia.mockResolvedValue({ ok: false, error: "all-candidates-failed" })
    const store = useDownloadStore()
    await store.ensureDownloaded(TRACK, PATH)
    expect(store.getState(TRACK)).toBe("failed")

    store.markPending(TRACK)
    await store.ensureDownloaded(TRACK, PATH)

    expect(deleteFile).toHaveBeenCalledWith(`https://cdn.test/${PATH}`)
  })

  it("shows the retry entry points the failed row under a claim", async () => {
    downloadMedia.mockResolvedValue({ ok: false, error: "all-candidates-failed" })
    const store = useDownloadStore()
    await store.ensureDownloaded(TRACK, PATH)

    store.markPending(TRACK)
    // What the row renders...
    expect(store.getState(TRACK)).toBe("pending")
    // ...and what the Home tap / sheet button must act on.
    expect(store.getEffectiveState(TRACK)).toBe("failed")
  })

  it("does not restore a claim over a row whose state was cleared meanwhile", async () => {
    // Cancelling a download DELETES the row's state. The claim must not put
    // the red X back on a row the user just asked us to drop — the guard in
    // `clearPending` depends on the canceller deleting rather than writing
    // "idle", so pin that contract here.
    downloadMedia.mockResolvedValue({ ok: false, error: "all-candidates-failed" })
    const store = useDownloadStore()
    await store.ensureDownloaded(TRACK, PATH)
    expect(store.getState(TRACK)).toBe("failed")

    store.markPending(TRACK)
    await store.remove(TRACK, `https://cdn.test/${PATH}`)
    store.clearPending(TRACK)

    expect(store.getState(TRACK)).toBe("idle")
  })

  it("never paints `downloading` for a track the storage budget refuses", async () => {
    hasRoom = false
    const store = useDownloadStore()
    const seen = trackStates(store)

    const url = await store.ensureDownloaded(TRACK, PATH)

    expect(url).toBeNull()
    expect(seen).toEqual(["pending", "deferred"])
    expect(seen).not.toContain("downloading")
    expect(downloadMedia).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
  })

  it("repairs a stale `ready` media row even when the budget refuses the transfer", async () => {
    // The cache probe came back empty, so the file is gone and any DB row
    // still claiming "ready" is a lie — one that would keep charging the
    // budget and painting a phantom "downloaded" badge. The gate must not
    // skip that repair.
    hasRoom = false
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)

    expect(upsert).toHaveBeenCalledWith(TRACK, "failed", null)
  })

  it("restores the state a claim replaced when it is released unresolved", async () => {
    downloadMedia.mockResolvedValue({ ok: false, error: "all-candidates-failed" })
    const store = useDownloadStore()
    await store.ensureDownloaded(TRACK, PATH)
    expect(store.getState(TRACK)).toBe("failed")

    // An `openTrack` that claims the row and then bails (stale generation,
    // rejected play plan) must not cost the row its retry affordance.
    store.markPending(TRACK)
    expect(store.getState(TRACK)).toBe("pending")
    store.clearPending(TRACK)
    expect(store.getState(TRACK)).toBe("failed")
  })

  it("holds the claim until the LAST caller releases it", () => {
    const store = useDownloadStore()

    // Two taps on the same (undisabled) Search row.
    store.markPending(TRACK)
    store.markPending(TRACK)
    store.clearPending(TRACK)
    expect(store.getState(TRACK)).toBe("pending")

    store.clearPending(TRACK)
    expect(store.getState(TRACK)).toBe("idle")
  })

  it("releases its own claim, so the next tap can claim the row again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    downloadMedia.mockRejectedValue(new Error("boom"))
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)
    expect(store.getState(TRACK)).toBe("failed")

    // A claim leaked by the task's `finally` would silently swallow this
    // one — the row would stay on its red X with no answer to the tap.
    store.markPending(TRACK)
    expect(store.getState(TRACK)).toBe("pending")
  })

  it("does not release a claim created after a data wipe", async () => {
    let releaseProbe: (value: string | null) => void = () => {}
    resolveLocalUrl.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseProbe = resolve
      })
    )
    const store = useDownloadStore()
    const stale = store.ensureDownloaded(TRACK, PATH)

    // "Clear user data" mid-download drops every claim...
    store.reset()
    // ...and a fresh open claims the same row while the old task settles.
    store.markPending(TRACK)
    expect(store.getState(TRACK)).toBe("pending")

    releaseProbe(null)
    await stale

    // The cancelled task's `finally` released a claim that was never its
    // own — the new download would lose its shimmer while genuinely running.
    expect(store.getState(TRACK)).toBe("pending")
  })

  it("leaves no `pending` behind on any exit path", async () => {
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)
    expect(store.getState(TRACK)).toBe("completed")

    // Cache hit.
    resolveLocalUrl.mockResolvedValue("file:///local/other.mp3")
    await store.ensureDownloaded("track-2", "public/audio/track-2.mp3")
    expect(store.getState("track-2")).toBe("completed")

    // Budget refusal.
    resolveLocalUrl.mockResolvedValue(null)
    hasRoom = false
    await store.ensureDownloaded("track-3", "public/audio/track-3.mp3")
    expect(store.getState("track-3")).toBe("deferred")
  })

  it("does not rewind a finished download or a live transfer to `pending`", () => {
    const store = useDownloadStore()

    store.markStartingDownload(TRACK)
    store.markPending(TRACK)
    expect(store.getState(TRACK)).toBe("downloading")
    // The refused claim releases nothing.
    store.clearPending(TRACK)
    expect(store.getState(TRACK)).toBe("downloading")
  })

  /* ----------------------------- issue #1484 ---------------------------- */

  it("tells the user when there is no connectivity", async () => {
    online(false)
    const store = useDownloadStore()

    const url = await store.ensureDownloaded(TRACK, PATH)

    expect(url).toBeNull()
    expect(store.getState(TRACK)).toBe("failed")
    expect(toastError).toHaveBeenCalledWith("errors.downloadFailed")
  })

  it("tells the user when every CDN candidate is exhausted", async () => {
    downloadMedia.mockResolvedValue({ ok: false, error: "all-candidates-failed" })
    const store = useDownloadStore()

    const url = await store.ensureDownloaded(TRACK, PATH)

    expect(url).toBeNull()
    expect(store.getState(TRACK)).toBe("failed")
    expect(toastError).toHaveBeenCalledWith("errors.downloadFailed")
  })

  it("tells the user when the transfer throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    downloadMedia.mockRejectedValue(new Error("boom"))
    const store = useDownloadStore()

    const url = await store.ensureDownloaded(TRACK, PATH)

    expect(url).toBeNull()
    expect(toastError).toHaveBeenCalledWith("errors.downloadFailed")
  })

  it("says storage-is-full — NOT a connectivity failure — on the budget gate", async () => {
    hasRoom = false
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)

    expect(toastAction).toHaveBeenCalledWith(
      "errors.downloadStorageFull",
      expect.objectContaining({ durationMs: 20_000 })
    )
    expect(toastError).not.toHaveBeenCalledWith("errors.downloadFailed")
  })

  it("rate-limits a draining queue to one notice", async () => {
    online(false)
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH, null, "queue")
    await store.ensureDownloaded("track-2", "public/audio/track-2.mp3", null, "queue")

    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it("never lets the queue's cooldown swallow the answer to a user's tap", async () => {
    online(false)
    const store = useDownloadStore()

    // A prefetch queue failing at launch arms the cooldown...
    await store.ensureDownloaded(TRACK, PATH, null, "queue")
    expect(toastError).toHaveBeenCalledTimes(1)

    // ...and the lecture the user taps a moment later is still answered.
    await store.ensureDownloaded("track-2", "public/audio/track-2.mp3")
    expect(toastError).toHaveBeenCalledTimes(2)
  })

  it("answers a tap that joins a transfer the queue had already started", async () => {
    // "Add a playlist, prefetch starts, tap one of those lectures" — the tap
    // shares the running task, so its answer must not be filed under the
    // queue's rate-limit.
    downloadMedia.mockResolvedValue({ ok: false, error: "all-candidates-failed" })
    const store = useDownloadStore()

    await store.ensureDownloaded("track-2", "public/audio/track-2.mp3", null, "queue")
    expect(toastError).toHaveBeenCalledTimes(1)

    let releaseProbe: (value: string | null) => void = () => {}
    resolveLocalUrl.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseProbe = resolve
      })
    )
    const queued = store.ensureDownloaded(TRACK, PATH, null, "queue")
    const tapped = store.ensureDownloaded(TRACK, PATH)

    releaseProbe(null)
    expect(await tapped).toBeNull()
    await queued
    // One shared transfer, not two — the tap joined rather than restarted.
    expect(downloadMedia).toHaveBeenCalledTimes(2)
    expect(toastError).toHaveBeenCalledTimes(2)
  })

  it("does not downgrade a user transfer a queue job joins", async () => {
    downloadMedia.mockResolvedValue({ ok: false, error: "all-candidates-failed" })
    const store = useDownloadStore()

    await store.ensureDownloaded("track-2", "public/audio/track-2.mp3", null, "queue")

    let releaseProbe: (value: string | null) => void = () => {}
    resolveLocalUrl.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseProbe = resolve
      })
    )
    const tapped = store.ensureDownloaded(TRACK, PATH)
    const joined = store.ensureDownloaded(TRACK, PATH, null, "queue")

    releaseProbe(null)
    await tapped
    await joined
    expect(toastError).toHaveBeenCalledTimes(2)
  })

  it("says nothing after a data wipe cancelled the task", async () => {
    let releaseTransfer: (value: unknown) => void = () => {}
    downloadMedia.mockReturnValue(
      new Promise((resolve) => {
        releaseTransfer = resolve
      })
    )
    const store = useDownloadStore()

    const task = store.ensureDownloaded(TRACK, PATH)
    await Promise.resolve()
    store.reset()
    releaseTransfer({ ok: false, error: "all-candidates-failed" })
    await task

    expect(toastError).not.toHaveBeenCalled()
    expect(store.getState(TRACK)).toBe("idle")
  })

  it("says nothing about storage after a data wipe cancelled the task", async () => {
    hasRoom = false
    let releaseProbe: (value: string | null) => void = () => {}
    resolveLocalUrl.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseProbe = resolve
      })
    )
    const store = useDownloadStore()

    const task = store.ensureDownloaded(TRACK, PATH)
    store.reset()
    releaseProbe(null)
    await task

    expect(toastError).not.toHaveBeenCalled()
    expect(toastAction).not.toHaveBeenCalled()
    expect(store.getState(TRACK)).toBe("idle")
  })

  it("stays quiet on success", async () => {
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)

    expect(toastError).not.toHaveBeenCalled()
    expect(toastAction).not.toHaveBeenCalled()
  })

  /* ----------------------------- issue #1487 ---------------------------- */

  it("offers a way past the limit on the notice itself", async () => {
    hasRoom = false
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)

    const [, opts] = toastAction.mock.calls[0]!
    expect(opts).toMatchObject({
      durationMs: 20_000,
      buttons: [{ text: "errors.downloadStorageFullAction" }],
    })
  })

  it("downloads the track when the user presses “Download anyway”", async () => {
    hasRoom = false
    toastAction.mockResolvedValue({ kind: "pressed", index: 0 })
    const store = useDownloadStore()

    // The refused call answers `null` immediately — it must not sit open for
    // the length of a toast — and the press starts the transfer behind it.
    // (Here the mocked toast resolves in a microtask, so the row has already
    // moved on from "deferred" by the time this resolves; the deferral itself
    // is pinned by the expired/dismissed cases below.)
    expect(await store.ensureDownloaded(TRACK, PATH)).toBeNull()
    await settleNotice()

    // Still no room: what got the bytes through is the one-off exception,
    // not a widened budget.
    expect(hasRoom).toBe(false)
    expect(downloadMedia).toHaveBeenCalledTimes(1)
    expect(store.getState(TRACK)).toBe("completed")
  })

  it("leaves the track deferred when the notice expires unpressed", async () => {
    hasRoom = false
    toastAction.mockResolvedValue({ kind: "expired" })
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)
    await settleNotice()

    expect(downloadMedia).not.toHaveBeenCalled()
    expect(store.getState(TRACK)).toBe("deferred")
  })

  it("leaves the track deferred when the notice is swiped away", async () => {
    hasRoom = false
    toastAction.mockResolvedValue({ kind: "dismissed" })
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)
    await settleNotice()

    expect(downloadMedia).not.toHaveBeenCalled()
    expect(store.getState(TRACK)).toBe("deferred")
  })

  it("spends the exception on one download and no more", async () => {
    hasRoom = false
    toastAction.mockResolvedValue({ kind: "pressed", index: 0 })
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)
    await settleNotice()
    expect(downloadMedia).toHaveBeenCalledTimes(1)

    // The same track, asked for again after the granted transfer landed: the
    // grant is gone, so the budget refuses it like any other.
    toastAction.mockResolvedValue({ kind: "expired" })
    await store.remove(TRACK, `https://cdn.test/${PATH}`)
    await store.ensureDownloaded(TRACK, PATH)
    await settleNotice()

    expect(downloadMedia).toHaveBeenCalledTimes(1)
    expect(store.getState(TRACK)).toBe("deferred")
  })

  it("grants nothing to another track", async () => {
    hasRoom = false
    toastAction.mockResolvedValue({ kind: "pressed", index: 0 })
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)
    await settleNotice()

    toastAction.mockResolvedValue({ kind: "expired" })
    await store.ensureDownloaded("track-2", "public/audio/track-2.mp3")
    await settleNotice()

    expect(downloadMedia).toHaveBeenCalledTimes(1)
    expect(store.getState("track-2")).toBe("deferred")
  })

  it("tells the prefetch queue nothing — neither an override nor a notice", async () => {
    // Nobody is waiting on a background job: a FIFO that can wave itself past
    // the limit is not a limit, and a FIFO that talks about it is the toast
    // that greeted every launch (#1578). The row's `deferred` state is the
    // whole signal.
    hasRoom = false
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH, null, "queue")

    expect(toastAction).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    expect(store.getState(TRACK)).toBe("deferred")
  })

  it("answers the next deliberate tap instead of going silent for a minute", async () => {
    hasRoom = false
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)
    await settleNotice()
    await store.ensureDownloaded("track-2", "public/audio/track-2.mp3")
    await settleNotice()

    expect(toastAction).toHaveBeenCalledTimes(2)
  })

  it("shows one budget notice at a time, not a stack", async () => {
    hasRoom = false
    let releaseNotice: (outcome: Outcome) => void = () => {}
    toastAction.mockReturnValue(
      new Promise<Outcome>((resolve) => {
        releaseNotice = resolve
      })
    )
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)
    await store.ensureDownloaded("track-2", "public/audio/track-2.mp3")

    expect(toastAction).toHaveBeenCalledTimes(1)
    releaseNotice({ kind: "expired" })
    await settleNotice()
  })
})

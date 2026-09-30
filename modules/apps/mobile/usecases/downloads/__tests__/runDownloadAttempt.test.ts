import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TrackId } from "@lib/domain/core.js"
import type { CdnServer } from "@lib/domain/servers.js"
import { STALLED, type DownloadPlatform } from "../downloadPorts.js"
import type { TransferHandle } from "../inFlightTransfers.js"
import { runDownloadAttempt, type DownloadAttemptDeps } from "../runDownloadAttempt.js"

const TRACK = "t-1" as TrackId
const SERVER = { id: "global", urlTemplate: "https://cdn.example/{path}" } as CdnServer
const PROBE_URL = "https://cdn.example/audio/t-1.mp3"
const boom = new Error("disk gone")

function transferHandle(): TransferHandle {
  let url: string | undefined
  return {
    trackId: TRACK,
    origin: { current: "user" },
    aborter: new AbortController(),
    setUrl: (next) => (url = next),
    url: () => url,
    release: vi.fn(),
  }
}

function harness(opts: { stalled?: boolean; offline?: boolean } = {}) {
  const upsert = vi.fn(async () => {
    throw boom
  })
  const files = {
    download: vi.fn(),
    delete: vi.fn(async () => {
      throw boom
    }),
    cancel: vi.fn(async () => {
      throw boom
    }),
    resolveLocalUrl: vi.fn(() =>
      opts.stalled ? new Promise<string | null>(() => {}) : Promise.resolve(null)
    ),
  }
  const platform = {
    files,
    repositories: () => ({ mediaItems: { upsert } }),
    activeServer: () => SERVER,
    promoteServer: vi.fn(),
    isOffline: () => opts.offline ?? false,
    startStallWatch: () => ({
      expired: opts.stalled ? Promise.resolve(STALLED) : new Promise<typeof STALLED>(() => {}),
      touch: vi.fn(),
      stop: vi.fn(),
    }),
  } as unknown as DownloadPlatform
  const quota = {
    isMeasured: true,
    ensureMeasured: async () => {},
    sizeOf: () => 1,
    hasRoomFor: () => true,
    reserve: vi.fn(),
    settle: vi.fn(),
    uncharge: vi.fn(),
  }
  const deps = {
    platform,
    rows: {
      currentEpoch: () => 1,
      setState: vi.fn(),
      setProgress: vi.fn(),
      clearPending: vi.fn(),
    },
    quota: () => quota,
    disk: { recordProbe: vi.fn() },
    notices: { announceDownloadFailed: vi.fn() },
    candidates: () => {
      throw new Error("no transfer in these tests")
    },
    prefetchTranscript: vi.fn(),
    spendBudgetException: () => false,
    dropBudgetException: vi.fn(),
    downloadAnyway: vi.fn(),
  } as unknown as DownloadAttemptDeps
  return { deps, files, upsert }
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function attempt(
  deps: DownloadAttemptDeps,
  isRetryAfterFailure = false
): Promise<string | null> {
  return runDownloadAttempt(
    { trackId: TRACK, path: "audio/t-1.mp3", isRetryAfterFailure, transfer: transferHandle() },
    deps
  )
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe("runDownloadAttempt — cleanup that fails is logged, and the attempt goes on", () => {
  it("logs a phantom row it cannot mark failed", async () => {
    const { deps } = harness({ offline: true })

    expect(await attempt(deps)).toBeNull()

    expect(warn).toHaveBeenCalledWith("[downloads] could not mark the row failed", boom)
  })

  it("logs a stalled transfer it cannot cancel or mark failed", async () => {
    const { deps, files } = harness({ stalled: true })

    expect(await attempt(deps)).toBeNull()
    await settle()

    expect(files.cancel).toHaveBeenCalledWith(PROBE_URL)
    expect(warn).toHaveBeenCalledWith("[downloads] cancel failed", boom)
    expect(warn).toHaveBeenCalledWith("[downloads] could not mark the row failed", boom)
  })

  it("logs a stale cached file it cannot delete before a retry", async () => {
    const { deps, files, upsert } = harness()

    expect(await attempt(deps, true)).toBeNull()

    expect(files.delete).toHaveBeenCalledWith(PROBE_URL)
    expect(warn).toHaveBeenCalledWith("[downloads] stale cache delete failed", boom)
    expect(upsert).toHaveBeenCalledWith(TRACK, "failed", null)
    expect(warn).toHaveBeenCalledWith("[downloads] could not mark the row failed", boom)
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TrackId } from "@lib/domain/core.js"
import type { PlaylistEntry } from "@usecases/playlist/listPlaylistTracks.js"

const getById = vi.fn()
const prefetch = vi.fn()
const clearStartingDownload = vi.fn()
const prefetchForTrack = vi.fn<(id: TrackId) => Promise<void>>(async () => {})

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({ repositories: () => ({ tracks: { getById } }) }),
}))
vi.mock("@shruti/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => ({ prefetch, clearStartingDownload }),
}))
vi.mock("@shruti/stores/downloads/useTranscriptPrefetch.js", () => ({
  useTranscriptPrefetch: vi.fn(() => ({ prefetchForTrack, backfillDownloaded: vi.fn() })),
}))

import { useTranscriptPrefetch } from "@shruti/stores/downloads/useTranscriptPrefetch.js"
import { usePlaylistPrefetch } from "../usePlaylistPrefetch.js"

function trackWithAudio(id: string, path = `t/${id}.mp3`, filesize = 100) {
  return {
    id: id as TrackId,
    variants: [{ audio: null }, { audio: { path, filesize } }],
  }
}

function entry(id: string, withAudio = true): PlaylistEntry {
  return {
    track: withAudio ? trackWithAudio(id) : { id: id as TrackId, variants: [{ audio: null }] },
  } as unknown as PlaylistEntry
}

describe("usePlaylistPrefetch.prefetchTrack", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("queues the first variant that actually carries audio", async () => {
    getById.mockResolvedValue(trackWithAudio("t-1", "audio/t-1.mp3", 4242))

    await usePlaylistPrefetch().prefetchTrack("t-1" as TrackId)

    expect(prefetch).toHaveBeenCalledWith("t-1", "audio/t-1.mp3", 4242)
    expect(clearStartingDownload).not.toHaveBeenCalled()
    expect(prefetchForTrack).toHaveBeenCalledWith("t-1")
  })

  it("clears the optimistic downloading flag when the track has no audio", async () => {
    getById.mockResolvedValue({ id: "t-2" as TrackId, variants: [{ audio: null }] })

    await usePlaylistPrefetch().prefetchTrack("t-2" as TrackId)

    expect(prefetch).not.toHaveBeenCalled()
    expect(clearStartingDownload).toHaveBeenCalledWith("t-2")
  })

  it("clears the optimistic downloading flag when the track lookup is missing", async () => {
    getById.mockResolvedValue(null)

    await usePlaylistPrefetch().prefetchTrack("t-3" as TrackId)

    expect(clearStartingDownload).toHaveBeenCalledWith("t-3")
  })

  it("clears the flag and still prefetches transcripts when the lookup throws", async () => {
    getById.mockRejectedValue(new Error("db gone"))

    await expect(usePlaylistPrefetch().prefetchTrack("t-4" as TrackId)).resolves.toBeUndefined()

    expect(clearStartingDownload).toHaveBeenCalledWith("t-4")
    expect(prefetchForTrack).toHaveBeenCalledWith("t-4")
  })

  it("builds the transcript prefetcher once, on first use", async () => {
    getById.mockResolvedValue(trackWithAudio("t-5"))
    const prefetcher = usePlaylistPrefetch()
    expect(useTranscriptPrefetch).not.toHaveBeenCalled()

    await prefetcher.prefetchTrack("t-5" as TrackId)
    await prefetcher.prefetchTrack("t-5" as TrackId)

    expect(useTranscriptPrefetch).toHaveBeenCalledOnce()
  })

  // Nobody awaits this call, so anything escaping it is an unhandled
  // rejection — and the prefetcher's whole contract is that a blip is
  // non-fatal.
  it("reports a rejected transcript prefetch instead of letting it escape", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    getById.mockResolvedValue(trackWithAudio("t-6"))
    const failure = new Error("404")
    prefetchForTrack.mockRejectedValueOnce(failure)

    await expect(usePlaylistPrefetch().prefetchTrack("t-6" as TrackId)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("transcript prefetch"), failure)
    expect(prefetch).toHaveBeenCalled()
  })

  it("settles when the transcript prefetcher cannot even be built", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    getById.mockResolvedValue(trackWithAudio("t-7"))
    vi.mocked(useTranscriptPrefetch).mockImplementationOnce(() => {
      throw new Error("composition root not ready")
    })

    await expect(usePlaylistPrefetch().prefetchTrack("t-7" as TrackId)).resolves.toBeUndefined()
  })
})

describe("usePlaylistPrefetch.prefetchAll", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prefetchForTrack.mockImplementation(async () => {})
  })

  it("queues audio only for entries that have it, but transcripts for every entry", async () => {
    usePlaylistPrefetch().prefetchAll([entry("a"), entry("b", false), entry("c")])
    await vi.waitFor(() => expect(prefetchForTrack).toHaveBeenCalledTimes(3))

    expect(prefetch.mock.calls.map((c) => c[0])).toEqual(["a", "c"])
    expect(prefetchForTrack.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b", "c"])
  })

  it("never runs more than three transcript fetches at once", async () => {
    let inFlight = 0
    let peak = 0
    prefetchForTrack.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise<void>((r) => setTimeout(r, 1))
      inFlight--
    })

    usePlaylistPrefetch().prefetchAll(Array.from({ length: 10 }, (_, i) => entry(`x-${i}`)))
    await vi.waitFor(() => expect(prefetchForTrack).toHaveBeenCalledTimes(10))

    expect(peak).toBe(3)
  })

  it("keeps draining the queue after a transcript fetch rejects", async () => {
    prefetchForTrack.mockImplementation(async (id: TrackId) => {
      if (id === ("y-0" as TrackId)) throw new Error("404")
    })

    usePlaylistPrefetch().prefetchAll(Array.from({ length: 5 }, (_, i) => entry(`y-${i}`)))
    await vi.waitFor(() => expect(prefetchForTrack).toHaveBeenCalledTimes(5))
  })

  it("does nothing on an empty playlist", async () => {
    usePlaylistPrefetch().prefetchAll([])

    expect(prefetch).not.toHaveBeenCalled()
    expect(prefetchForTrack).not.toHaveBeenCalled()
  })
})

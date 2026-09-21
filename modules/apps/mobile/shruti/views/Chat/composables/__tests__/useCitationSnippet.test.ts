import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { CdnServer } from "@lib/domain/servers.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackAudio, TrackVariant } from "@lib/domain/trackVariant.js"
import type { TrackId } from "@lib/domain/core.js"

/* -- Module doubles ----------------------------------------------------- */

const server: CdnServer = {
  id: "test",
  name: "Test region",
  urlTemplate: "https://cdn.example/{path}",
  shareAudioUrl: "https://api.example/share/audio",
  shareVideoUrl: "https://api.example/share/video",
  authBaseUrl: "https://api.example/auth",
  chatBaseUrl: "https://api.example/chat",
}

interface CutRequest {
  sourceKey: string
  startMs: number
  endMs: number
  excerptId: string
}

let cutResult: { url: string; ready: boolean } = { url: "", ready: true }
const cuts: CutRequest[] = []
const getById = vi.fn<(id: TrackId) => Promise<Track | null>>()

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({ tracks: { getById } }),
    shareAudioService: {
      cut: async (req: CutRequest) => {
        cuts.push(req)
        return cutResult
      },
    },
    activeServer: ref(server),
  }),
}))

const { useCitationSnippet } = await import("../useCitationSnippet.js")

/* -- Fixtures ----------------------------------------------------------- */

function variant(audioPath: string | undefined): TrackVariant {
  const audio: TrackAudio | null =
    audioPath === undefined
      ? null
      : { path: audioPath, filesize: null, duration: 1000, kind: "original" }
  return {
    trackId: "t1",
    language: "ru",
    title: "Вечерняя лекция",
    audios: audio ? [audio] : [],
    audio,
    transcript: null,
    outline: null,
    description: null,
  }
}

function track(audioPath?: string): Track {
  return {
    id: "t1",
    authorId: null,
    locationId: null,
    date: "1991-02-03",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [variant(audioPath)],
  }
}

/** URLs answered with 200 by the HEAD probe; anything else is a 404. */
let onCdn = new Set<string>()
const probes: string[] = []

beforeEach(() => {
  onCdn = new Set()
  probes.length = 0
  cuts.length = 0
  cutResult = { url: "", ready: true }
  getById.mockReset()
  getById.mockResolvedValue(track("library/t1.mp3"))
  vi.stubGlobal("fetch", async (url: string) => {
    probes.push(url)
    return { ok: onCdn.has(url) } as Response
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A window nobody else in this file uses, so the process-lifetime URL cache
 *  cannot answer for it. */
let nextStart = 0
function window_(): { trackId: string; startMs: number; endMs: number } {
  nextStart += 1000
  return { trackId: "t1", startMs: nextStart, endMs: nextStart + 500 }
}

const predicted = (ref: { trackId: string; startMs: number; endMs: number }): string =>
  `https://cdn.example/public/shares/audio/chat-cite-${ref.trackId}-${ref.startMs}-${ref.endMs}.mp3`

describe("resolving a citation snippet", () => {
  it("uses the excerpt already on the CDN without cutting it again", async () => {
    const ref = window_()
    onCdn.add(predicted(ref))

    const url = await useCitationSnippet().resolveUrl(ref)

    expect(url).toBe(predicted(ref))
    expect(cuts).toEqual([])
  })

  it("cuts the excerpt from the track's audio when the CDN has nothing", async () => {
    const ref = window_()
    cutResult = { url: "https://cdn.example/cut/excerpt.mp3", ready: true }

    const url = await useCitationSnippet().resolveUrl(ref)

    expect(url).toBe("https://cdn.example/cut/excerpt.mp3")
    expect(cuts).toEqual([
      {
        sourceKey: "library/t1.mp3",
        startMs: ref.startMs,
        endMs: ref.endMs,
        excerptId: `chat-cite-t1-${ref.startMs}-${ref.endMs}`,
      },
    ])
  })

  it("cuts from the id's canonical path when the catalog has no such track", async () => {
    const ref = window_()
    getById.mockResolvedValue(null)

    await useCitationSnippet().resolveUrl(ref)

    expect(cuts[0]!.sourceKey).toContain("t1")
  })

  it("falls back to the predictable URL when the cutter answers without one", async () => {
    const ref = window_()
    cutResult = { url: "", ready: true }

    expect(await useCitationSnippet().resolveUrl(ref)).toBe(predicted(ref))
  })

  it("waits for an async cut to land before handing the URL over", async () => {
    const ref = window_()
    const cutUrl = "https://cdn.example/cut/pending.mp3"
    cutResult = { url: cutUrl, ready: false }
    onCdn.add(cutUrl)

    const url = await useCitationSnippet().resolveUrl(ref)

    expect(url).toBe(cutUrl)
    // The first probe missed the predicted URL; the poll then confirmed the
    // cut one before the chip was told to play it.
    expect(probes).toEqual([predicted(ref), cutUrl])
  })

  it("refuses a translation-only track that has no audio anywhere", async () => {
    getById.mockResolvedValue(track(undefined))

    await expect(useCitationSnippet().resolveUrl(window_())).rejects.toThrow("no-audio")
    expect(cuts).toEqual([])
  })

  it("treats a failed probe as a miss rather than an error", async () => {
    const ref = window_()
    vi.stubGlobal("fetch", async () => {
      throw new Error("network is down")
    })

    expect(await useCitationSnippet().resolveUrl(ref)).toBe(predicted(ref))
    expect(cuts).toHaveLength(1)
  })

  it("answers a re-mounted chip from the cache instead of probing again", async () => {
    const ref = window_()
    onCdn.add(predicted(ref))
    const first = await useCitationSnippet().resolveUrl(ref)

    probes.length = 0
    onCdn.clear()
    cutResult = { url: "https://cdn.example/cut/second.mp3", ready: true }

    expect(await useCitationSnippet().resolveUrl({ ...ref })).toBe(first)
    expect(probes).toEqual([])
    expect(cuts).toEqual([])
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const ctx = vi.hoisted(() => ({ activeId: "a" }))

vi.mock("@capacitor/device", () => ({
  Device: { getId: async () => ({ identifier: "device-1" }) },
}))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    activeServer: {
      get value() {
        return { id: ctx.activeId }
      },
    },
    setActiveServerById: vi.fn(),
    auth: {
      refreshAccessToken: async () => "fresh-token",
      onSessionChange: () => () => {},
    },
  }),
}))

function region(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    urlTemplate: `https://${id}.example/{path}`,
    shareAudioUrl: `https://api-${id}.example/share/audio/excerpts`,
    shareVideoUrl: `https://api-${id}.example/share/video/reels`,
    shareTranscriptUrl: `https://api-${id}.example/share/transcripts`,
    authBaseUrl: `https://api-${id}.example/auth`,
    chatBaseUrl: `https://api-${id}.example`,
    profileBaseUrl: `https://api-${id}.example`,
    orchestratorBaseUrl: `https://api-${id}.example`,
    discoveryBaseUrl: `https://api-${id}.example`,
    ...extra,
  }
}

const regions = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock("@shruti/services/regionsRegistry.js", () => ({ getRegions: () => regions.list }))

import { createServiceRequests } from "../serviceRequests.js"
import { NetworkError } from "../http/networkError.js"
import { useHttpShareAudioService } from "@infra/shareAudio/http/useHttpShareAudioService.js"

/** The first region's API answers 503; every other one answers 200. */
function stubFetchFirstDown() {
  const urls: string[] = []
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    return new Response("{}", { status: url.includes("api-a.") ? 503 : 200 })
  })
  globalThis.fetch = fn as never
  return { urls, fn }
}

const POST: RequestInit = { method: "POST", body: "{}" }

beforeEach(() => {
  ctx.activeId = "a"
  regions.list = [region("a"), region("b")]
})

describe("share requests stay on the active region", () => {
  // A share service uploads to its own region's storage, and the app builds
  // the artifact URL on the active region: a render answered elsewhere would
  // point at a file the active storage does not have.
  it("does not walk a share-audio cut to another region, even one naming its excerpt", async () => {
    const { urls } = stubFetchFirstDown()
    await expect(createServiceRequests().shareAudioRequest("", POST)).rejects.toThrow()
    expect(urls).toEqual(["https://api-a.example/share/audio/excerpts"])
  })

  it("surfaces a failed cut from the active region instead of a link into another region's storage", async () => {
    const { urls } = stubFetchFirstDown()
    const audio = useHttpShareAudioService(
      createServiceRequests().shareAudioRequest,
      (key) => `https://a.example/${key}`
    )

    const cut = audio.cut({ sourceKey: "k", startMs: 0, endMs: 1_000, excerptId: "n1" })

    await expect(cut).rejects.toThrow()
    expect(urls).toEqual(["https://api-a.example/share/audio/excerpts"])
  })

  it("does not walk a share-video render to another region", async () => {
    const { urls } = stubFetchFirstDown()
    await expect(createServiceRequests().shareVideoRequest("", POST)).rejects.toThrow()
    expect(urls).toEqual(["https://api-a.example/share/video/reels"])
  })

  it("does not walk a transcript render to another region", async () => {
    const { urls } = stubFetchFirstDown()
    await expect(createServiceRequests().shareTranscriptRequest("/pdf", POST)).rejects.toThrow()
    expect(urls).toEqual(["https://api-a.example/share/transcripts/pdf"])
  })

  it("derives the transcript door from chat when the region has none", async () => {
    regions.list = [region("a", { shareTranscriptUrl: undefined })]
    const { urls } = stubFetchFirstDown()
    await createServiceRequests()
      .shareTranscriptRequest("/pdf", POST)
      .catch(() => undefined)
    expect(urls).toEqual(["https://api-a.example/share/transcripts/pdf"])
  })
})

describe("orchestrator submissions through region failover", () => {
  it("replays POST /orchestrator/run on the next region", async () => {
    const { urls } = stubFetchFirstDown()
    const res = await createServiceRequests().ingestRequest("/orchestrator/run", POST)
    expect(res.status).toBe(200)
    expect(urls).toEqual([
      "https://api-a.example/orchestrator/run",
      "https://api-b.example/orchestrator/run",
    ])
  })

  it("keeps any other orchestrator POST on the active region", async () => {
    const { urls } = stubFetchFirstDown()
    await expect(
      createServiceRequests().ingestRequest("/orchestrator/other", POST)
    ).rejects.toThrow()
    expect(urls).toEqual(["https://api-a.example/orchestrator/other"])
  })
})

describe("while a fallback-only region is active", () => {
  it("fails every API client at once with a NetworkError and sends nothing", async () => {
    regions.list = [region("a"), region("z", { fallbackOnly: true })]
    ctx.activeId = "z"
    const { fn } = stubFetchFirstDown()
    const s = createServiceRequests()

    const calls: Promise<unknown>[] = [
      s.authRequest("/anonymous", POST),
      s.chatRequest("/title"),
      s.profileRequest("/profile/sync/pull", POST),
      s.ingestRequest("/orchestrator/run", POST),
      s.discoveryRequest("/discovery/search", POST),
      s.shareAudioRequest("", POST),
      s.shareVideoRequest("", POST),
      s.shareTranscriptRequest("/pdf", POST),
    ]
    const errors = await Promise.all(
      calls.map((p) =>
        p.then(
          () => null,
          (e: unknown) => e
        )
      )
    )

    for (const err of errors) expect(err).toBeInstanceOf(NetworkError)
    expect(fn).not.toHaveBeenCalled()
  })
})

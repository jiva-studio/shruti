import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useHttpShareAudioService } from "../useHttpShareAudioService.js"
import { joinUrl } from "@kit/servers"

/** The failover transport pinned to one endpoint, as the adapter sees it. */
function atEndpoint(base: string) {
  return (path: string, init: RequestInit) => fetch(joinUrl(base, path), init)
}

/** The active region's storage, on the same host the fixtures answer from. */
const onCdn = (key: string): string => `https://cdn.example/${key}`

describe("useHttpShareAudioService", () => {
  const fetchMock = vi.fn()
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function ok(body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  it("POSTs to the endpoint returned by the getter and maps snake_case → camelCase", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        excerpt_id: "note-1",
        url: "https://cdn.example/public/shares/audio/note-1.mp3",
        ready: true,
      })
    )

    const svc = useHttpShareAudioService(atEndpoint("https://share.example/excerpts"), onCdn)
    const result = await svc.cut({
      sourceKey: "public/tracks/t1/audio/original.mp3",
      startMs: 1000,
      endMs: 4000,
      excerptId: "note-1",
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://share.example/excerpts")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
      source_key: "public/tracks/t1/audio/original.mp3",
      start_ms: 1000,
      end_ms: 4000,
      excerpt_id: "note-1",
    })
    expect(result).toEqual({
      excerptId: "note-1",
      url: "https://cdn.example/public/shares/audio/note-1.mp3",
      ready: true,
    })
  })

  it("omits excerpt_id from the body when not provided (server generates one)", async () => {
    fetchMock.mockResolvedValueOnce(ok({ excerpt_id: "auto", url: "u", ready: true }))

    const svc = useHttpShareAudioService(atEndpoint("https://endpoint"), onCdn)
    await svc.cut({ sourceKey: "k", startMs: 0, endMs: 100 })

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"))
    expect(body).not.toHaveProperty("excerpt_id")
    expect(body).toEqual({ source_key: "k", start_ms: 0, end_ms: 100 })
  })

  it("passes ready:false through from the server (202 dispatched-async response)", async () => {
    // The server answers immediately with 202 + ready:false when it
    // dispatched a background worker. The adapter is a thin pass-through
    // and the caller (e.g. useCitationSnippet) handles the polling.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          excerpt_id: "note-x",
          url: "https://cdn.example/public/shares/audio/note-x.mp3",
          ready: false,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      )
    )

    const svc = useHttpShareAudioService(atEndpoint("https://endpoint"), onCdn)
    const result = await svc.cut({ sourceKey: "k", startMs: 0, endMs: 1, excerptId: "note-x" })

    expect(result).toEqual({
      excerptId: "note-x",
      url: "https://cdn.example/public/shares/audio/note-x.mp3",
      ready: false,
    })
  })

  it("throws on non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 504, statusText: "Gateway Timeout" })
    )

    const svc = useHttpShareAudioService(atEndpoint("https://endpoint"), onCdn)
    await expect(svc.cut({ sourceKey: "k", startMs: 0, endMs: 1 })).rejects.toThrow(/504/)
  })

  it("falls through to ready:false when the cut aborts (real abort path, not a faked err.name)", async () => {
    vi.useFakeTimers()
    // fetch never resolves; rejects with the bare reason the runtime
    // surfaces on abort. We do NOT set err.name — the adapter must rely
    // on signal.aborted, which is the actual production behaviour.
    fetchMock.mockImplementation((_url, init) => {
      return new Promise((_, reject) => {
        const sig = (init as RequestInit | undefined)?.signal as AbortSignal | undefined
        sig?.addEventListener("abort", () => reject(sig.reason), { once: true })
      })
    })

    const svc = useHttpShareAudioService(atEndpoint("https://share.example/excerpts"), onCdn)
    const promise = svc.cut({ sourceKey: "k", startMs: 0, endMs: 1000, excerptId: "n1" })

    await vi.advanceTimersByTimeAsync(8_000)
    const result = await promise
    // ready:false + no url → the caller polls its predicted URL.
    expect(result).toEqual({ excerptId: "n1", url: "", ready: false })
    vi.useRealTimers()
  })

  it("re-throws a genuine (non-abort) network error rather than swallowing it", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))

    const svc = useHttpShareAudioService(atEndpoint("https://endpoint"), onCdn)
    await expect(svc.cut({ sourceKey: "k", startMs: 0, endMs: 1 })).rejects.toThrow(
      /Failed to fetch/
    )
  })

  it("coerces ready:true with an empty/relative/garbage url to ready:false (caller polls)", async () => {
    for (const badUrl of ["", "/relative/path.mp3", "not-a-url", "ftp://x/y.mp3"]) {
      fetchMock.mockResolvedValueOnce(ok({ excerpt_id: "n1", url: badUrl, ready: true }))
      const svc = useHttpShareAudioService(atEndpoint("https://endpoint"), onCdn)
      const result = await svc.cut({ sourceKey: "k", startMs: 0, endMs: 1, excerptId: "n1" })
      expect(result).toEqual({ excerptId: "n1", url: "", ready: false })
    }
  })

  it("keeps ready:true for a valid absolute https url (no poll)", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ excerpt_id: "n1", url: "https://cdn.example/public/shares/audio/n1.mp3", ready: true })
    )
    const svc = useHttpShareAudioService(atEndpoint("https://endpoint"), onCdn)
    const result = await svc.cut({ sourceKey: "k", startMs: 0, endMs: 1, excerptId: "n1" })
    expect(result).toEqual({
      excerptId: "n1",
      url: "https://cdn.example/public/shares/audio/n1.mp3",
      ready: true,
    })
  })
})

describe("useHttpShareAudioService — exists", () => {
  const fetchMock = vi.fn()
  const excerpt = "https://cdn.example/public/shares/audio/chat-cite-t1-0-500.mp3"

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function service() {
    return useHttpShareAudioService(atEndpoint("https://share.example/excerpts"), onCdn)
  }

  it("asks the CDN with a HEAD for the excerpt url", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))

    expect(await service().exists(excerpt)).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(excerpt)
    expect((init as RequestInit).method).toBe("HEAD")
  })

  it("disarms the four-second cap once the CDN answers", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))

    await service().exists(excerpt)

    expect(vi.getTimerCount()).toBe(0)
  })

  it("answers false for an excerpt the CDN does not have", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))

    expect(await service().exists(excerpt)).toBe(false)
  })

  it("answers false when the probe cannot reach the CDN", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))

    expect(await service().exists(excerpt)).toBe(false)
  })

  it("gives up on a probe that hangs after four seconds", async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url, init) => {
      return new Promise((_, reject) => {
        const sig = (init as RequestInit | undefined)?.signal as AbortSignal | undefined
        sig?.addEventListener("abort", () => reject(sig.reason), { once: true })
      })
    })

    const answer = service().exists(excerpt)
    await vi.advanceTimersByTimeAsync(3_999)
    let settled = false
    void answer.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(await answer).toBe(false)
  })
})

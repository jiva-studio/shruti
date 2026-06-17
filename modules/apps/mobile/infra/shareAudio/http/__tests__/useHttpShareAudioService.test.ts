import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useHttpShareAudioService } from "../useHttpShareAudioService.js"

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
      ok({ excerpt_id: "note-1", url: "https://cdn/share/audio/note-1.mp3", ready: true })
    )

    const svc = useHttpShareAudioService(() => "https://aws/excerpts")
    const result = await svc.cut({
      sourceKey: "public/tracks/t1/audio/original.mp3",
      startMs: 1000,
      endMs: 4000,
      excerptId: "note-1",
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://aws/excerpts")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
      source_key: "public/tracks/t1/audio/original.mp3",
      start_ms: 1000,
      end_ms: 4000,
      excerpt_id: "note-1",
    })
    expect(result).toEqual({
      excerptId: "note-1",
      url: "https://cdn/share/audio/note-1.mp3",
      ready: true,
    })
  })

  it("resolves the endpoint lazily on each call (so settings flips between regions take effect)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(ok({ excerpt_id: "x", url: "https://x", ready: true }))
    )

    let region: "global" | "russia" = "global"
    const svc = useHttpShareAudioService(() =>
      region === "global"
        ? "https://aws.example/excerpts"
        : "https://yc.example/d4er0qjat23q6ic6dt0p"
    )

    await svc.cut({ sourceKey: "k", startMs: 0, endMs: 1000 })
    expect(fetchMock.mock.calls[0]![0]).toBe("https://aws.example/excerpts")

    region = "russia"
    await svc.cut({ sourceKey: "k", startMs: 0, endMs: 1000 })
    expect(fetchMock.mock.calls[1]![0]).toBe("https://yc.example/d4er0qjat23q6ic6dt0p")
  })

  it("omits excerpt_id from the body when not provided (server generates one)", async () => {
    fetchMock.mockResolvedValueOnce(ok({ excerpt_id: "auto", url: "u", ready: true }))

    const svc = useHttpShareAudioService(() => "https://endpoint")
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
          url: "https://cdn/share/audio/note-x.mp3",
          ready: false,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      )
    )

    const svc = useHttpShareAudioService(() => "https://endpoint")
    const result = await svc.cut({ sourceKey: "k", startMs: 0, endMs: 1, excerptId: "note-x" })

    expect(result).toEqual({
      excerptId: "note-x",
      url: "https://cdn/share/audio/note-x.mp3",
      ready: false,
    })
  })

  it("throws on non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 504, statusText: "Gateway Timeout" })
    )

    const svc = useHttpShareAudioService(() => "https://endpoint")
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

    const svc = useHttpShareAudioService(() => "https://yc.example/excerpts")
    const promise = svc.cut({ sourceKey: "k", startMs: 0, endMs: 1000, excerptId: "n1" })

    await vi.advanceTimersByTimeAsync(8_000)
    const result = await promise
    // ready:false + no url → the caller polls its predicted URL.
    expect(result).toEqual({ excerptId: "n1", url: "", ready: false })
    vi.useRealTimers()
  })

  it("re-throws a genuine (non-abort) network error rather than swallowing it", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))

    const svc = useHttpShareAudioService(() => "https://endpoint")
    await expect(svc.cut({ sourceKey: "k", startMs: 0, endMs: 1 })).rejects.toThrow(
      /Failed to fetch/
    )
  })

  it("coerces ready:true with an empty/relative/garbage url to ready:false (caller polls)", async () => {
    for (const badUrl of ["", "/relative/path.mp3", "not-a-url", "ftp://x/y.mp3"]) {
      fetchMock.mockResolvedValueOnce(ok({ excerpt_id: "n1", url: badUrl, ready: true }))
      const svc = useHttpShareAudioService(() => "https://endpoint")
      const result = await svc.cut({ sourceKey: "k", startMs: 0, endMs: 1, excerptId: "n1" })
      expect(result).toEqual({ excerptId: "n1", url: "", ready: false })
    }
  })

  it("keeps ready:true for a valid absolute https url (no poll)", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ excerpt_id: "n1", url: "https://cdn/share/audio/n1.mp3", ready: true })
    )
    const svc = useHttpShareAudioService(() => "https://endpoint")
    const result = await svc.cut({ sourceKey: "k", startMs: 0, endMs: 1, excerptId: "n1" })
    expect(result).toEqual({
      excerptId: "n1",
      url: "https://cdn/share/audio/n1.mp3",
      ready: true,
    })
  })
})

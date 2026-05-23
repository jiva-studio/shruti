import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useHttpShareVideoService } from "../useHttpShareVideoService.js"

describe("useHttpShareVideoService", () => {
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
      ok({ video_id: "note-1", url: "https://cdn/share/video/note-1.mp4", ready: true })
    )

    const svc = useHttpShareVideoService(
      () => "https://aws/reels",
      async () => "test-token"
    )
    const result = await svc.cut({
      sourceKey: "public/tracks/t1/audio/original.mp3",
      startMs: 1000,
      endMs: 4000,
      text: "exact transcript",
      lang: "ru",
      theme: "prabhupada",
      videoId: "note-1",
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://aws/reels")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
      source_key: "public/tracks/t1/audio/original.mp3",
      start_ms: 1000,
      end_ms: 4000,
      text: "exact transcript",
      lang: "ru",
      theme: "prabhupada",
      video_id: "note-1",
    })
    expect(result).toEqual({
      videoId: "note-1",
      url: "https://cdn/share/video/note-1.mp4",
      ready: true,
    })
  })

  it("resolves the endpoint lazily on each call (so settings flips between regions take effect)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(ok({ video_id: "x", url: "https://x", ready: true }))
    )

    let region: "global" | "russia" = "global"
    const svc = useHttpShareVideoService(
      () =>
        region === "global"
          ? "https://aws.example/reels"
          : "https://yc.example/d4er0qjat23q6ic6dt0p",
      async () => "test-token"
    )

    await svc.cut({
      sourceKey: "k",
      startMs: 0,
      endMs: 1000,
      text: "t",
      lang: "ru",
      theme: "prabhupada",
    })
    expect(fetchMock.mock.calls[0]![0]).toBe("https://aws.example/reels")

    region = "russia"
    await svc.cut({
      sourceKey: "k",
      startMs: 0,
      endMs: 1000,
      text: "t",
      lang: "ru",
      theme: "prabhupada",
    })
    expect(fetchMock.mock.calls[1]![0]).toBe("https://yc.example/d4er0qjat23q6ic6dt0p")
  })

  it("omits video_id from the body when not provided (server generates one)", async () => {
    fetchMock.mockResolvedValueOnce(ok({ video_id: "auto", url: "u", ready: true }))

    const svc = useHttpShareVideoService(
      () => "https://endpoint",
      async () => "test-token"
    )
    await svc.cut({
      sourceKey: "k",
      startMs: 0,
      endMs: 100,
      text: "t",
      lang: "ru",
      theme: "prabhupada",
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"))
    expect(body).not.toHaveProperty("video_id")
    expect(body).toEqual({
      source_key: "k",
      start_ms: 0,
      end_ms: 100,
      text: "t",
      lang: "ru",
      theme: "prabhupada",
    })
  })

  it("falls through to ready:false when the cut takes longer than 8s (server still rendering)", async () => {
    vi.useFakeTimers()
    // fetch never resolves; rejects with AbortError when the controller signals.
    fetchMock.mockImplementation((_url, init) => {
      return new Promise((_, reject) => {
        const sig = (init as RequestInit | undefined)?.signal as AbortSignal | undefined
        sig?.addEventListener(
          "abort",
          () => {
            const err = new Error("aborted") as Error & { name: string }
            err.name = "AbortError"
            reject(err)
          },
          { once: true }
        )
      })
    })

    const svc = useHttpShareVideoService(
      () => "https://yc.example/reels",
      async () => "test-token"
    )
    const promise = svc.cut({
      sourceKey: "k",
      startMs: 0,
      endMs: 1000,
      text: "t",
      lang: "ru",
      theme: "prabhupada",
      videoId: "n1",
    })

    await vi.advanceTimersByTimeAsync(8_000)
    const result = await promise
    expect(result).toEqual({ videoId: "n1", url: "", ready: false })
    vi.useRealTimers()
  })

  it("throws on non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 504, statusText: "Gateway Timeout" })
    )

    const svc = useHttpShareVideoService(
      () => "https://endpoint",
      async () => "test-token"
    )
    await expect(
      svc.cut({
        sourceKey: "k",
        startMs: 0,
        endMs: 1,
        text: "t",
        lang: "ru",
        theme: "prabhupada",
      })
    ).rejects.toThrow(/504/)
  })
})

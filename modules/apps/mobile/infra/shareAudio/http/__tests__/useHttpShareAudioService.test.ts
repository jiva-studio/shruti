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

  it("throws on non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 504, statusText: "Gateway Timeout" })
    )

    const svc = useHttpShareAudioService(() => "https://endpoint")
    await expect(svc.cut({ sourceKey: "k", startMs: 0, endMs: 1 })).rejects.toThrow(/504/)
  })
})

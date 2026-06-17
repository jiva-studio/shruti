import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useHttpShareTranscriptService } from "../useHttpShareTranscriptService.js"

describe("useHttpShareTranscriptService", () => {
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

  it("POSTs to `${base}/pdf` (trimming a trailing slash) with the mapped body", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ url: "https://cdn/share/transcripts/t1.pdf", ready: true })
    )

    const svc = useHttpShareTranscriptService(() => "https://aws.example/share/transcripts/")
    const result = await svc.renderPdf({
      trackId: "t1",
      lang: "ru",
      transcriptKey: "public/tracks/t1/transcripts/ru.json",
      title: "Title",
      author: "Author",
      date: "1977-01-01",
      location: "Bombay",
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://aws.example/share/transcripts/pdf")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
      track_id: "t1",
      lang: "ru",
      transcript_key: "public/tracks/t1/transcripts/ru.json",
      title: "Title",
      author_name: "Author",
      date: "1977-01-01",
      location_name: "Bombay",
    })
    expect(result).toEqual({ url: "https://cdn/share/transcripts/t1.pdf", ready: true })
  })

  it("resolves the base lazily on each call (so settings flips between regions take effect)", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(ok({ url: "https://x", ready: true })))

    let region: "global" | "russia" = "global"
    const svc = useHttpShareTranscriptService(() =>
      region === "global"
        ? "https://aws.example/share/transcripts"
        : "https://yc.example/share/transcripts"
    )

    await svc.renderPdf({ trackId: "t", lang: "ru", transcriptKey: "k" })
    expect(fetchMock.mock.calls[0]![0]).toBe("https://aws.example/share/transcripts/pdf")

    region = "russia"
    await svc.renderPdf({ trackId: "t", lang: "ru", transcriptKey: "k" })
    expect(fetchMock.mock.calls[1]![0]).toBe("https://yc.example/share/transcripts/pdf")
  })

  it("passes ready:false through from the server (dispatched-async response)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ url: "https://cdn/share/transcripts/t1.pdf", ready: false }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    )

    const svc = useHttpShareTranscriptService(() => "https://endpoint")
    const result = await svc.renderPdf({ trackId: "t1", lang: "ru", transcriptKey: "k" })
    expect(result).toEqual({ url: "https://cdn/share/transcripts/t1.pdf", ready: false })
  })

  it("falls through to ready:false when the render aborts (real abort path, not a faked err.name)", async () => {
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

    const svc = useHttpShareTranscriptService(() => "https://yc.example/share/transcripts")
    const promise = svc.renderPdf({ trackId: "t1", lang: "ru", transcriptKey: "k" })

    await vi.advanceTimersByTimeAsync(8_000)
    const result = await promise
    // ready:false + no url → the caller polls its predicted URL.
    expect(result).toEqual({ url: "", ready: false })
    vi.useRealTimers()
  })

  it("re-throws a genuine (non-abort) network error rather than swallowing it", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))

    const svc = useHttpShareTranscriptService(() => "https://endpoint")
    await expect(svc.renderPdf({ trackId: "t1", lang: "ru", transcriptKey: "k" })).rejects.toThrow(
      /Failed to fetch/
    )
  })

  it("coerces ready:true with an empty/relative/garbage url to ready:false (caller polls)", async () => {
    for (const badUrl of ["", "/relative/path.pdf", "not-a-url", "ftp://x/y.pdf"]) {
      fetchMock.mockResolvedValueOnce(ok({ url: badUrl, ready: true }))
      const svc = useHttpShareTranscriptService(() => "https://endpoint")
      const result = await svc.renderPdf({ trackId: "t1", lang: "ru", transcriptKey: "k" })
      expect(result).toEqual({ url: "", ready: false })
    }
  })

  it("keeps ready:true for a valid absolute https url (no poll)", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ url: "https://cdn/share/transcripts/t1.pdf", ready: true })
    )
    const svc = useHttpShareTranscriptService(() => "https://endpoint")
    const result = await svc.renderPdf({ trackId: "t1", lang: "ru", transcriptKey: "k" })
    expect(result).toEqual({ url: "https://cdn/share/transcripts/t1.pdf", ready: true })
  })

  it("throws on non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 504, statusText: "Gateway Timeout" })
    )

    const svc = useHttpShareTranscriptService(() => "https://endpoint")
    await expect(svc.renderPdf({ trackId: "t1", lang: "ru", transcriptKey: "k" })).rejects.toThrow(
      /504/
    )
  })
})
